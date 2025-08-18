import React, { useEffect, useRef, useState } from "react";
import { record } from "rrweb";

/**
 * Repro React SDK (MVP)
 * - Floating "Record / Stop & Report" button
 * - Bootstrap -> start session -> rrweb capture
 * - Intercepts window.fetch to inject X-Bug-Session-Id / X-Bug-Action-Id
 * - Generates Action IDs on clicks; posts minimal action events
 * - Uses ORIGINAL fetch for SDK-internal calls to avoid recursion
 */

type Props = {
    appId: string;
    apiBase?: string; // default: http://localhost:4000
    children: React.ReactNode;
    button?: { text?: string }; // optional override label
};

// ---- small helpers ----
const now = () => Date.now();
const newAID = () => `A_${now()}_${Math.random().toString(36).slice(2, 6)}`;

async function getJSON<T>(url: string) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()) as T;
}

const INTERNAL_HEADER = "X-Repro-Internal";

// --- manual Axios attach support (module-scoped ctx) ---
type ReproCtx = {
    base: string;
    getSid: () => string | null;
    getAid: () => string | null;
    getToken: () => string | null;
    getFetch: () => typeof window.fetch;
    hasReqMarked: Set<string>;
};
let __reproCtx: ReproCtx | null = null;

/** Manually attach Repro to any Axios instance (no recursion). */
export function attachAxios(axiosInstance: any) {
    if (!axiosInstance || (axiosInstance as any).__reproAttached) return;
    (axiosInstance as any).__reproAttached = true;

    axiosInstance.interceptors.request.use((config: any) => {
        const ctx = __reproCtx;
        if (!ctx) return config;

        const sid = ctx.getSid();
        const aid = ctx.getAid();
        const url = `${config.baseURL || ""}${config.url || ""}`;
        const isInternal = url.startsWith(ctx.base);
        const isSdkInternal = !!config.headers?.[INTERNAL_HEADER];

        if (sid && aid && !isInternal && !isSdkInternal) {
            config.headers = config.headers || {};
            config.headers["X-Bug-Session-Id"] = sid;
            config.headers["X-Bug-Action-Id"] = aid;
        }
        return config;
    });

    axiosInstance.interceptors.response.use(
        async (resp: any) => {
            const ctx = __reproCtx;
            if (!ctx) return resp;

            const url = `${resp.config.baseURL || ""}${resp.config.url || ""}`;
            const isInternal = url.startsWith(ctx.base);
            const isSdkInternal = !!resp.config.headers?.[INTERNAL_HEADER];

            const sid = ctx.getSid();
            const aid = ctx.getAid();
            const token = ctx.getToken();

            if (!isInternal && !isSdkInternal && sid && aid && token && !ctx.hasReqMarked.has(aid)) {
                ctx.hasReqMarked.add(aid);
                try {
                    await ctx.getFetch()(`${ctx.base}/v1/sessions/${sid}/events`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${token}`,
                            [INTERNAL_HEADER]: "1",
                        },
                        body: JSON.stringify({
                            seq: Date.now(),
                            events: [{ type: "action", aid, tStart: Date.now(), tEnd: Date.now(), hasReq: true, ui: {} }],
                        }),
                    } as RequestInit);
                } catch {}
            }
            return resp;
        },
        (err: any) => Promise.reject(err)
    );
}

export function ReproProvider({ appId, apiBase, children, button }: Props) {
    const base = apiBase || "http://localhost:4000";

    // ---- refs & state (hooks MUST be inside component) ----
    const sdkTokenRef = useRef<string | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const stopRecRef = useRef<() => void>();
    const rrwebEventsRef = useRef<any[]>([]);
    const currentAidRef = useRef<string | null>(null);
    const aidExpiryTimerRef = useRef<number | null>(null);
    const origFetchRef = useRef<typeof window.fetch>();
    const hasReqMarkedRef = useRef<Set<string>>(new Set());
    const lastActionLabelRef = useRef<string | null>(null);

    // NEW: track installed click handler + dedupe recent clicks
    const clickHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);
    const lastClickRef = useRef<{ t: number; label: string } | null>(null);

    const [ready, setReady] = useState(false);
    const [recording, setRecording] = useState(false);

    // keep manual-attach ctx in sync so attachAxios() sees live refs
    useEffect(() => {
        __reproCtx = {
            base,
            getSid: () => sessionIdRef.current,
            getAid: () => currentAidRef.current,
            getToken: () => sdkTokenRef.current,
            getFetch: () => (origFetchRef.current ?? window.fetch.bind(window)),
            hasReqMarked: hasReqMarkedRef.current,
        };
        return () => {
            __reproCtx = null;
        };
    }, [base]);

    // ---- bootstrap once ----
    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const resp = await getJSON<{ enabled: boolean; sdkToken?: string }>(
                    `${base}/v1/sdk/bootstrap?appId=${encodeURIComponent(appId)}`
                );
                if (mounted && resp.enabled && resp.sdkToken) {
                    sdkTokenRef.current = resp.sdkToken;
                    setReady(true);
                } else {
                    setReady(false);
                }
            } catch {
                setReady(false);
            }
        })();
        return () => {
            mounted = false;
        };
    }, [appId, base]);

    /**
     * Auto-attach to window.axios if present.
     * If a team uses a custom Axios instance, they can call exported attachAxios(instance).
     */
    function attachAxiosIfPresent() {
        const ax: any = (window as any).axios;
        if (!ax || ax.__reproAttached) return;
        ax.__reproAttached = true;

        ax.interceptors.request.use((config: any) => {
            const sid = sessionIdRef.current;
            const aid = currentAidRef.current;
            const url = `${config.baseURL || ""}${config.url || ""}`;
            const isInternal = url.startsWith(base);
            const isSdkInternal = config.headers?.[INTERNAL_HEADER] != null;

            if (sid && aid && !isInternal && !isSdkInternal) {
                config.headers = config.headers || {};
                config.headers["X-Bug-Session-Id"] = sid;
                config.headers["X-Bug-Action-Id"] = aid;
            }
            return config;
        });

        ax.interceptors.response.use(
            async (resp: any) => {
                const url = `${resp.config.baseURL || ""}${resp.config.url || ""}`;
                const hdrs = resp.config.headers || {};
                const isInternal = url.startsWith(base);
                const isSdkInternal = hdrs[INTERNAL_HEADER] != null;

                if (
                    !isInternal &&
                    !isSdkInternal &&
                    sessionIdRef.current &&
                    currentAidRef.current &&
                    sdkTokenRef.current &&
                    !hasReqMarkedRef.current.has(currentAidRef.current)
                ) {
                    hasReqMarkedRef.current.add(currentAidRef.current);
                    // use ORIGINAL fetch to avoid recursion
                    await origFetchRef.current!(`${base}/v1/sessions/${sessionIdRef.current}/events`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${sdkTokenRef.current}`,
                            [INTERNAL_HEADER]: "1",
                        },
                        body: JSON.stringify({
                            seq: Date.now(),
                            events: [
                                {
                                    type: "action",
                                    aid: currentAidRef.current,
                                    tStart: Date.now(),
                                    tEnd: Date.now(),
                                    hasReq: true,
                                    ui: {},
                                },
                            ],
                        }),
                    }).catch(() => {});
                }
                return resp;
            },
            (err: any) => Promise.reject(err)
        );
    }

    // ---- derive a label from a click target (best-effort, minimal) ----
    function labelFromClickTarget(target: EventTarget | null): string {
        const el = target as HTMLElement | null;
        if (!el) return "Click";
        const txt =
            (el.innerText || el.getAttribute?.("aria-label") || "").trim().slice(0, 40) ||
            el.getAttribute?.("title") ||
            "";
        const id = el.id ? `#${el.id}` : "";
        const cls =
            el.className && typeof el.className === "string"
                ? `.${el.className.split(" ").slice(0, 2).join(".")}`
                : "";
        return txt ? `Click • ${txt}` : `Click • ${(el.tagName || "el").toLowerCase()}${id || cls}`;
    }

    // ---- START recording ----
    async function start() {
        if (!sdkTokenRef.current || recording) return;

        // 1) start session
        const r = await fetch(`${base}/v1/sessions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${sdkTokenRef.current}`,
            },
            body: JSON.stringify({ clientTime: now() }),
        });
        if (!r.ok) return;
        const sess = (await r.json()) as { sessionId: string; clockOffsetMs: number };
        sessionIdRef.current = sess.sessionId;

        // 2) hold original fetch & install interceptor
        origFetchRef.current = window.fetch.bind(window);
        window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
            // figure request url
            const urlStr =
                typeof input === "string" || input instanceof URL
                    ? String(input)
                    : (input as Request).url;

            // existing incoming headers (if any)
            const hdrsIn = new Headers(
                init.headers || ((input as any)?.headers as HeadersInit) || {}
            );
            const isInternal = urlStr.startsWith(base);
            const isSdkInternal =
                hdrsIn.has(INTERNAL_HEADER) || hdrsIn.has(INTERNAL_HEADER.toLowerCase());

            // inject bug headers for app requests only (not our API or SDK-internal posts)
            if (sessionIdRef.current && currentAidRef.current && !isInternal && !isSdkInternal) {
                const headers = new Headers(init.headers || {});
                headers.set("X-Bug-Session-Id", sessionIdRef.current);
                headers.set("X-Bug-Action-Id", currentAidRef.current);
                init.headers = headers;
            }

            // always call ORIGINAL fetch to avoid recursion
            const res = await origFetchRef.current!(input as any, init);

            // mark hasReq ONCE per action (skip internal/API calls)
            if (
                !isInternal &&
                !isSdkInternal &&
                sessionIdRef.current &&
                currentAidRef.current &&
                sdkTokenRef.current &&
                !hasReqMarkedRef.current.has(currentAidRef.current)
            ) {
                hasReqMarkedRef.current.add(currentAidRef.current);
                try {
                    await origFetchRef.current!(
                        `${base}/v1/sessions/${sessionIdRef.current}/events`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                Authorization: `Bearer ${sdkTokenRef.current}`,
                                [INTERNAL_HEADER]: "1",
                            },
                            body: JSON.stringify({
                                seq: now(),
                                events: [
                                    {
                                        type: "action",
                                        aid: currentAidRef.current,
                                        // label: lastActionLabelRef.current ?? undefined, // optional
                                        tStart: now(),
                                        tEnd: now(),
                                        hasReq: true,
                                        ui: {},
                                    },
                                ],
                            }),
                        }
                    );
                } catch {
                    /* ignore in MVP */
                }
            }

            return res;
        };
        attachAxiosIfPresent();

        // 3) click -> new ActionId + minimal action event (via ORIGINAL fetch)
        // Remove any previous handler to avoid duplicates
        if (clickHandlerRef.current) {
            document.removeEventListener("click", clickHandlerRef.current, { capture: true } as any);
            clickHandlerRef.current = null;
        }

        const clickHandler = (evt: MouseEvent) => {
            if (!sessionIdRef.current || !sdkTokenRef.current) return;

            // Skip clicks on the SDK's own UI
            const targetEl = evt.target as HTMLElement | null;
            if (targetEl && targetEl.closest('[data-repro-internal="1"]')) return;

            // Dedupe: ignore same-label clicks within 250ms (dev/StrictMode safety)
            const label = labelFromClickTarget(targetEl);
            const t = now();
            if (lastClickRef.current && t - lastClickRef.current.t < 250 && lastClickRef.current.label === label) {
                return;
            }
            lastClickRef.current = { t, label };

            const aid = newAID();
            currentAidRef.current = aid;
            lastActionLabelRef.current = label;

            if (aidExpiryTimerRef.current) window.clearTimeout(aidExpiryTimerRef.current);
            aidExpiryTimerRef.current = window.setTimeout(() => {
                currentAidRef.current = null;
            }, 5000);

            // post action row (internal; avoid recursion)
            origFetchRef.current!(
                `${base}/v1/sessions/${sessionIdRef.current}/events`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${sdkTokenRef.current}`,
                        [INTERNAL_HEADER]: "1",
                    },
                    body: JSON.stringify({
                        seq: t,
                        events: [
                            {
                                type: "action",
                                aid,
                                label,
                                tStart: t,
                                tEnd: t,
                                hasReq: false,
                                hasDb: false,
                                error: false,
                                ui: { kind: "click" },
                            },
                        ],
                    }),
                }
            ).catch(() => {});
        };

        clickHandlerRef.current = clickHandler;
        document.addEventListener("click", clickHandler, { capture: true });

        // 4) rrweb: keep events in memory; upload on stop()
        stopRecRef.current = record({
            emit: (ev: any) => {
                rrwebEventsRef.current.push(ev);
            },
        });

        // 5) cleanup registration
        (stop as any)._cleanup = () => {
            if (clickHandlerRef.current) {
                document.removeEventListener("click", clickHandlerRef.current, { capture: true } as any);
                clickHandlerRef.current = null;
            }
        };

        setRecording(true);
    }

    // ---- STOP recording ----
    async function stop() {
        if (!recording) return;

        // stop rrweb + listeners
        stopRecRef.current?.();
        (stop as any)._cleanup?.();

        const origFetch = origFetchRef.current ?? window.fetch.bind(window);
        const sid = sessionIdRef.current!;
        const token = sdkTokenRef.current!;

        // 1) upload rrweb chunks (internal; use original fetch)
        try {
            const events = rrwebEventsRef.current;
            const CHUNK = 500;
            for (let i = 0; i < events.length; i += CHUNK) {
                const slice = events.slice(i, i + CHUNK);
                await origFetch(`${base}/v1/sessions/${sid}/events`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                        [INTERNAL_HEADER]: "1",
                    },
                    body: JSON.stringify({
                        seq: i,
                        events: slice.map((e: any) => ({
                            type: "rrweb",
                            t: e.timestamp,
                            chunk: JSON.stringify(e),
                        })),
                    }),
                });
            }
        } catch {
            /* ignore in MVP */
        } finally {
            rrwebEventsRef.current = [];
        }

        // 2) finish (internal; use original fetch)
        try {
            const res = await origFetch(`${base}/v1/sessions/${sid}/finish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    [INTERNAL_HEADER]: "1",
                },
                body: JSON.stringify({ notes: "" }),
            });
            const fin = await res.json();
            if (fin?.viewerUrl) window.open(fin.viewerUrl, "_blank");
        } catch {
            /* ignore in MVP */
        }

        // 3) restore fetch & reset
        if (origFetchRef.current) window.fetch = origFetchRef.current;
        sessionIdRef.current = null;
        currentAidRef.current = null;
        lastActionLabelRef.current = null;
        hasReqMarkedRef.current.clear();
        if (aidExpiryTimerRef.current) window.clearTimeout(aidExpiryTimerRef.current);
        // also reset dedupe
        lastClickRef.current = null;

        setRecording(false);
    }

    // ---- UI (floating button) ----
    const btnLabel = recording ? (button?.text ?? "Stop & Report") : (button?.text ?? "Record");

    return (
        <>
            {children}
            {ready && (
                <button
                    data-repro-internal="1"
                    onClick={() => (recording ? stop() : start())}
                    style={{
                        position: "fixed",
                        right: 16,
                        bottom: 16,
                        zIndex: 2147483647,
                        padding: "10px 14px",
                        borderRadius: 12,
                        border: "1px solid #ccc",
                        background: recording ? "#ffe5e5" : "#e5f6ff",
                        cursor: "pointer",
                        fontFamily: "ui-sans-serif, system-ui, -apple-system",
                    }}
                >
                    {btnLabel}
                </button>
            )}
        </>
    );
}

export default ReproProvider;
