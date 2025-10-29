import React, { useEffect, useRef, useState } from "react";
import { record } from "rrweb";
import { gzip } from 'pako';

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
    tenantId: string;
    apiBase?: string; // default: http://localhost:4000
    children: React.ReactNode;
    button?: { text?: string }; // optional override label
};

// config
const MAX_BYTES = 900 * 1024; // 900 KB target per POST (tune)

// estimate JSON bytes
function jsonBytes(obj: any): number {
    try { return new TextEncoder().encode(JSON.stringify(obj)).length; } catch { return Infinity; }
}

// split [events] into <= MAX_BYTES chunks by bisection
function splitEventsBySize(events: any[], mkEnvelope: (slice:any[]) => any): any[][] {
    const out: any[][] = [];
    const stack: any[][] = [events.slice(0)]; // LIFO for fewer allocs
    while (stack.length) {
        const cur = stack.pop()!;
        const env = mkEnvelope(cur);
        if (jsonBytes(env) <= MAX_BYTES || cur.length <= 1) {
            out.push(cur);
            continue;
        }
        const mid = Math.floor(cur.length / 2);
        stack.push(cur.slice(0, mid));
        stack.push(cur.slice(mid));
    }
    return out;
}

// ---- small helpers ----
const now = () => Date.now();
const newAID = () => `A_${now()}_${Math.random().toString(36).slice(2, 6)}`;

// server time normalization
const offsetRef = { current: 0 };              // ms to add to client time
const nowServer = () => now() + (offsetRef.current || 0);


async function getJSON<T>(url: string, headers?: HeadersInit) {
    const r = await fetch(url, headers ? { headers } : undefined);
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()) as T;
}

const INTERNAL_HEADER = "X-Repro-Internal";
const REQUEST_START_HEADER = "X-Bug-Request-Start";
const TENANT_HEADER = "x-tenant-id";

// --- manual Axios attach support (module-scoped ctx) ---
type ReproCtx = {
    base: string;
    getSid: () => string | null;
    getAid: () => string | null;
    getToken: () => string | null;
    getUserToken: () => string | null;
    getTenantId: () => string | null;
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
        const tenantId = ctx.getTenantId();
        const url = `${config.baseURL || ""}${config.url || ""}`;
        const isInternal = url.startsWith(ctx.base);
        const isSdkInternal = !!config.headers?.[INTERNAL_HEADER];

        if (!config.headers) config.headers = {};
        const setHeader = (key: string, value: string) => {
            if (!config.headers) return;
            if (typeof (config.headers as any).set === "function") {
                (config.headers as any).set(key, value);
            } else {
                (config.headers as any)[key] = value;
            }
        };
        if (!isSdkInternal) {
            const requestStart = nowServer();
            setHeader(REQUEST_START_HEADER, String(requestStart));
        }
        if (isInternal && tenantId) {
            setHeader(TENANT_HEADER, tenantId);
        }
        if (sid && aid && !isInternal && !isSdkInternal) {
            setHeader("X-Bug-Session-Id", sid);
            setHeader("X-Bug-Action-Id", aid);
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
            const userToken = ctx.getUserToken();
            const tenantId = ctx.getTenantId();

            if (!isInternal && !isSdkInternal && sid && aid && token && !ctx.hasReqMarked.has(aid)) {
                ctx.hasReqMarked.add(aid);
                try {
                    await ctx.getFetch()(`${ctx.base}/v1/sessions/${sid}/events`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${token}`,
                            ...(userToken ? { "x-app-user-token": userToken } : {}),
                            ...(tenantId ? { [TENANT_HEADER]: tenantId } : {}),
                            [INTERNAL_HEADER]: "1",
                        },
                        body: JSON.stringify({
                            seq: nowServer(),
                            events: [{ type: "action", aid, tStart: nowServer(), tEnd: nowServer(), hasReq: true, ui: {} }],
                        }),
                    } as RequestInit);
                } catch {}
            }
            return resp;
        },
        (err: any) => Promise.reject(err)
    );
}

type ActionMeta = { tStart: number; label?: string };

export function ReproProvider({ appId, tenantId, apiBase, children, button }: Props) {
    const base = apiBase || "http://localhost:4000";
    type StoredAuth = { email: string; token: string; data: any } | null;
    const storageKey = `repro-auth-${tenantId}-${appId}`;

    const initialAuth: StoredAuth = (() => {
        if (typeof window === "undefined") return null;
        try {
            const raw = window.localStorage.getItem(storageKey);
            if (!raw) return null;
            return JSON.parse(raw) as StoredAuth;
        } catch {
            return null;
        }
    })();

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
    const actionMeta = useRef<Map<string, ActionMeta>>(new Map());
    const nextSeqRef = useRef<number>(1); // rrweb chunk counter
    const isFlushingRef = useRef(false);
    const backoffRef = useRef(0); // ms

    // NEW: track installed click handler + dedupe recent clicks
    const clickHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);
    const lastClickRef = useRef<{ t: number; label: string } | null>(null);

    const [ready, setReady] = useState(false);
    const [recording, setRecording] = useState(false);
    const [auth, setAuth] = useState<StoredAuth>(initialAuth);
    const userTokenRef = useRef<string | null>(initialAuth?.token ?? null);
    const tenantIdRef = useRef<string>(tenantId);
    const [showLogin, setShowLogin] = useState(false);
    const [loginEmail, setLoginEmail] = useState(initialAuth?.email ?? "");
    const [loginToken, setLoginToken] = useState(initialAuth?.token ?? "");
    const [loginError, setLoginError] = useState<string | null>(null);
    const [isLoggingIn, setIsLoggingIn] = useState(false);
    const disableLogin = isLoggingIn || !loginEmail.trim() || !loginToken.trim();

    const addTenantHeader = (headers: Record<string, string>) => {
        const tenant = tenantIdRef.current;
        return tenant ? { ...headers, [TENANT_HEADER]: tenant } : headers;
    };

    const setTenantOnHeaders = (headers: Headers) => {
        const tenant = tenantIdRef.current;
        if (tenant) headers.set(TENANT_HEADER, tenant);
    };

    // keep manual-attach ctx in sync so attachAxios() sees live refs
    useEffect(() => {
        tenantIdRef.current = tenantId;
    }, [tenantId]);

    useEffect(() => {
        __reproCtx = {
            base,
            getSid: () => sessionIdRef.current,
            getAid: () => currentAidRef.current,
            getToken: () => sdkTokenRef.current,
            getUserToken: () => userTokenRef.current,
            getTenantId: () => tenantIdRef.current,
            getFetch: () => (origFetchRef.current ?? window.fetch.bind(window)),
            hasReqMarked: hasReqMarkedRef.current,
        };
        return () => {
            __reproCtx = null;
        };
    }, [base, tenantId]);

    useEffect(() => {
        userTokenRef.current = auth?.token ?? null;
        if (typeof window !== "undefined") {
            try {
                if (auth) {
                    window.localStorage.setItem(storageKey, JSON.stringify(auth));
                } else {
                    window.localStorage.removeItem(storageKey);
                }
            } catch {
                /* ignore storage failures */
            }
        }
    }, [auth, storageKey]);

    const requireAuth = () => {
        if (!auth) {
            setShowLogin(true);
            return false;
        }
        return true;
    };

    async function login(email: string, token: string) {
        setIsLoggingIn(true);
        setLoginError(null);
        try {
            const resp = await fetch(`${base}/v1/apps/${appId}/users/login`, {
                method: "POST",
                headers: addTenantHeader({
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "x-app-user-token": token,
                    [INTERNAL_HEADER]: "1",
                }),
                body: JSON.stringify({ email, token }),
            });
            if (!resp.ok) {
                throw new Error(`Login failed (${resp.status})`);
            }
            const data = await resp.json();
            setAuth({ email, token, data });
            setShowLogin(false);
        } catch (err: any) {
            setLoginError(err?.message || "Unable to login");
        } finally {
            setIsLoggingIn(false);
        }
    }

    function handleLoginSubmit(evt: React.FormEvent) {
        evt.preventDefault();
        if (disableLogin) return;
        login(loginEmail.trim(), loginToken.trim());
    }

    useEffect(() => {
        if (!showLogin) {
            setLoginError(null);
        }
    }, [showLogin]);

    // ---- bootstrap once ----
    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const resp = await getJSON<{ enabled: boolean; sdkToken?: string }>(
                    `${base}/v1/sdk/bootstrap?appId=${encodeURIComponent(appId)}`,
                    addTenantHeader({ [INTERNAL_HEADER]: "1" })
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

    const rrBufferRef = useRef<any[]>([]);
    const rrFlushTimerRef = useRef<number | null>(null);
    const CHUNK_SIZE = 80;         // send when buffer hits 200 events
    const FLUSH_MS = 1500;          // or every 2s, whichever first


    async function sendChunkGzip({ baseUrl, sid, token, envelope, seq }:{
        baseUrl:string; sid:string; token:string; envelope:any; seq:number;
    }): Promise<'ok'|'too_large'|'fail'> {
        try {
            const json = JSON.stringify({ ...envelope, seq });
            const gz = gzip(json); // Uint8Array
            const r = await (origFetchRef.current ?? window.fetch)(`${baseUrl}/v1/sessions/${sid}/events`, {
                method: "POST",
                headers: addTenantHeader({
                    "Content-Type": "application/json",
                    "Content-Encoding": "gzip",
                    Authorization: `Bearer ${token}`,
                    ...(userTokenRef.current ? { "x-app-user-token": userTokenRef.current } : {}),
                    [INTERNAL_HEADER]: "1",
                }),
                body: gz,
            });
            if (r.status === 413) return 'too_large';
            if (!r.ok) return 'fail';
            return 'ok';
        } catch {
            return 'fail';
        }
    }

    async function flushRrwebBuffer(reason: 'size'|'timer'|'stop') {
        if (isFlushingRef.current) return;
        const sid = sessionIdRef.current;
        const token = sdkTokenRef.current;
        const baseUrl = apiBase || "http://localhost:4000";
        if (!sid || !token) return;
        if (!rrBufferRef.current.length) return;

        isFlushingRef.current = true;
        try {
            if (backoffRef.current > 0) {
                await new Promise(r => setTimeout(r, backoffRef.current));
            }

            // COPY buffer; do not mutate until we know what succeeded
            const fullSlice = rrBufferRef.current.slice(0);
            const seq = nextSeqRef.current; // do NOT increment yet

            const mkEnvelope = (slice:any[]) => {
                const tFirst = slice[0]?.timestamp ?? nowServer();
                const tLast  = slice[slice.length - 1]?.timestamp ?? tFirst;
                return { type: 'rrweb', seq, tFirst, tLast, events: slice };
            };

            // Pre-split by size into <= MAX_BYTES pieces (same seq for first, then seq+1, …)
            const pieces = splitEventsBySize(fullSlice, mkEnvelope);

            // Send each piece in order, incrementing seq only on success per piece
            let sentCount = 0;
            for (let i = 0; i < pieces.length; i++) {
                const piece = pieces[i];
                const pieceSeq = seq + i; // stable seq per piece
                const env = mkEnvelope(piece);

                const jsonSize = jsonBytes(env);
                let res: 'ok' | 'too_large' | 'fail';

                if (jsonSize > 64 * 1024) {
                    res = await sendChunkGzip({ baseUrl, sid, token, envelope: env, seq: pieceSeq });
                } else {
                    res = await sendChunk({ baseUrl, sid, token, envelope: env, seq: pieceSeq });
                }
                if (res === 'ok') {
                    sentCount += piece.length;
                    nextSeqRef.current = pieceSeq + 1; // advance to next expected seq
                    backoffRef.current = 0;
                    continue;
                }

                if (res === 'too_large' && piece.length > 1) {
                    // If a piece is STILL too large after pre-split, split it again and retry
                    const more = splitEventsBySize(piece, mkEnvelope);
                    // splice into 'pieces' at current position
                    pieces.splice(i, 1, ...more);
                    i -= 1; // reprocess at same index
                    continue;
                }

                // failure: stop; keep remaining events in buffer for retry
                backoffRef.current = Math.min(4000, (backoffRef.current || 250) * 2);
                break;
            }

            // success for `sentCount` events → drop them from buffer
            if (sentCount > 0) {
                rrBufferRef.current.splice(0, sentCount);
            }
        } finally {
            isFlushingRef.current = false;
        }
    }

    async function sendChunk({ baseUrl, sid, token, envelope, seq }:{
        baseUrl:string; sid:string; token:string; envelope:any; seq:number;
    }): Promise<'ok'|'too_large'|'fail'> {
        try {
            const r = await (origFetchRef.current ?? window.fetch)(`${baseUrl}/v1/sessions/${sid}/events`, {
                method: "POST",
                headers: addTenantHeader({
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    ...(userTokenRef.current ? { "x-app-user-token": userTokenRef.current } : {}),
                    [INTERNAL_HEADER]: "1",
                }),
                body: JSON.stringify({ ...envelope, seq }), // ensure seq matches piece
            });
            if (r.status === 413) return 'too_large';
            if (!r.ok) return 'fail';
            return 'ok';
        } catch {
            return 'fail';
        }
    }


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

            if (isInternal && tenantIdRef.current) {
                config.headers = config.headers || {};
                config.headers[TENANT_HEADER] = tenantIdRef.current;
            }

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
                        headers: addTenantHeader({
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${sdkTokenRef.current}`,
                            ...(userTokenRef.current ? { "x-app-user-token": userTokenRef.current } : {}),
                            [INTERNAL_HEADER]: "1",
                        }),
                        body: JSON.stringify({
                            seq: nowServer(),
                            events: [
                                {
                                    type: "action",
                                    aid: currentAidRef.current,
                                    label: lastActionLabelRef.current,
                                    tStart: nowServer(),
                                    tEnd: nowServer(),
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
        if (!requireAuth()) return;

        const r = await fetch(`${base}/v1/sessions`, {
            method: "POST",
            headers: addTenantHeader({
                "Content-Type": "application/json",
                Authorization: `Bearer ${sdkTokenRef.current}`,
                ...(userTokenRef.current ? { "x-app-user-token": userTokenRef.current } : {}),
            }),
            body: JSON.stringify({ clientTime: nowServer() }),
        });
        if (!r.ok) {
            if (r.status === 401) {
                setAuth(null);
                setShowLogin(true);
            }
            return;
        }
        const sess = (await r.json()) as { sessionId: string; clockOffsetMs: number };
        sessionIdRef.current = sess.sessionId;                 // <-- MISSING, add this
        offsetRef.current = Number(sess.clockOffsetMs || 0);

        // 2) hold original fetch & install interceptor
        origFetchRef.current = window.fetch.bind(window);
        nextSeqRef.current = 1;                                // reset for new session
        rrBufferRef.current = [];

        if (rrFlushTimerRef.current) window.clearInterval(rrFlushTimerRef.current);
        rrFlushTimerRef.current = window.setInterval(() => {
            flushRrwebBuffer('timer');
        }, FLUSH_MS);

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
            const headers = new Headers(init.headers || {});
            setTenantOnHeaders(headers);
            if (!isSdkInternal) {
                const requestStart = nowServer();
                headers.set(REQUEST_START_HEADER, String(requestStart));
            }
            if (sessionIdRef.current && currentAidRef.current && !isInternal && !isSdkInternal) {
                headers.set("X-Bug-Session-Id", sessionIdRef.current);
                headers.set("X-Bug-Action-Id", currentAidRef.current);
            }
            init.headers = headers;

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
                            headers: addTenantHeader({
                                "Content-Type": "application/json",
                                Authorization: `Bearer ${sdkTokenRef.current}`,
                                ...(userTokenRef.current ? { "x-app-user-token": userTokenRef.current } : {}),
                                [INTERNAL_HEADER]: "1",
                            }),
                            body: JSON.stringify({
                                seq: nowServer(),
                                events: [
                                    {
                                        type: "action",
                                        aid: currentAidRef.current,
                                        label: lastActionLabelRef.current,
                                        tStart: nowServer(),
                                        tEnd: nowServer(),
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
            const t = nowServer();
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
                    headers: addTenantHeader({
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${sdkTokenRef.current}`,
                        ...(userTokenRef.current ? { "x-app-user-token": userTokenRef.current } : {}),
                        [INTERNAL_HEADER]: "1",
                    }),
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
                rrBufferRef.current.push(ev);
                // stream out if we reach CHUNK_SIZE
                if (rrBufferRef.current.length >= CHUNK_SIZE) {
                    flushRrwebBuffer('size');
                }
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

        // clear periodic timer
        if (rrFlushTimerRef.current) {
            window.clearInterval(rrFlushTimerRef.current);
            rrFlushTimerRef.current = null;
        }

        // final flush of whatever is left
        await flushRrwebBuffer('stop');

        const origFetch = origFetchRef.current ?? window.fetch.bind(window);
        const sid = sessionIdRef.current!;
        const token = sdkTokenRef.current!;

        // 1) upload rrweb chunks (internal; use original fetch)
        try {
            const events = rrwebEventsRef.current;
            const CHUNK = 500;
            for (let i = 0; i < events.length; i += CHUNK) {
                const slice = events.slice(i, i + CHUNK);
                const seq = nextSeqRef.current++;
                const tFirst = slice[0]?.timestamp ?? nowServer();
                const tLast  = slice[slice.length - 1]?.timestamp ?? tFirst;

                await origFetch(`${base}/v1/sessions/${sid}/events`, {
                    method: "POST",
                    headers: addTenantHeader({
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                        ...(userTokenRef.current ? { "x-app-user-token": userTokenRef.current } : {}),
                        [INTERNAL_HEADER]: "1",
                    }),
                    body: JSON.stringify({
                        type: "rrweb",
                        seq,
                        tFirst,
                        tLast,
                        events: slice, // send raw array
                    }),
                });
            }
        } catch {
            /* ignore in MVP */
        } finally {
            rrwebEventsRef.current = [];
            nextSeqRef.current = 1;
            actionMeta.current.clear();
        }

        // 2) finish (internal; use original fetch)
        try {
            const res = await origFetch(`${base}/v1/sessions/${sid}/finish`, {
                method: "POST",
                headers: addTenantHeader({
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    ...(userTokenRef.current ? { "x-app-user-token": userTokenRef.current } : {}),
                    [INTERNAL_HEADER]: "1",
                }),
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
    const loginLabel = "Authenticate to Record";

    const buttonBaseStyle: React.CSSProperties = {
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 2147483647,
        padding: "12px 22px",
        borderRadius: 4,
        border: "1px solid #d1d5db",
        background: "#f4f5f7",
        cursor: "pointer",
        fontFamily: "ui-sans-serif, system-ui, -apple-system",
        fontSize: "14px",
        fontWeight: 600,
        color: "#1f2933",
        boxShadow: "0 14px 24px rgba(15, 23, 42, 0.16)",
        transition: "transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease",
    };

    const recordButtonStyle: React.CSSProperties = {
        ...buttonBaseStyle,
        background: recording ? "#fbeaea" : "#f3f4f6",
        borderColor: recording ? "#f5b8b8" : "#d1d5db",
        color: recording ? "#9b1c1c" : "#1f2933",
    };

    const loginButtonStyle: React.CSSProperties = {
        ...buttonBaseStyle,
        background: "#ffffff",
        borderColor: "#d1d5db",
        color: "#1f2933",
    };

    const modalOverlayStyle: React.CSSProperties = {
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.38)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2147483648,
        padding: 16,
    };

    const modalStyle: React.CSSProperties = {
        width: "100%",
        maxWidth: 360,
        background: "#ffffff",
        borderRadius: 12,
        boxShadow: "0 20px 40px rgba(15, 23, 42, 0.25)",
        padding: "24px 24px 20px",
        fontFamily: "ui-sans-serif, system-ui, -apple-system",
    };

    const labelStyle: React.CSSProperties = {
        display: "block",
        fontSize: 13,
        fontWeight: 600,
        color: "#111827",
        marginBottom: 6,
    };

    const inputStyle: React.CSSProperties = {
        width: "100%",
        padding: "10px 12px",
        borderRadius: 6,
        border: "1px solid #d1d5db",
        fontSize: 14,
        marginBottom: 14,
        boxSizing: "border-box",
        fontFamily: "inherit",
    };

    return (
        <>
            {children}
            {ready && auth && (
                <button
                    data-repro-internal="1"
                    onClick={() => (recording ? stop() : start())}
                    style={recordButtonStyle}
                >
                    {btnLabel}
                </button>
            )}
            {ready && !auth && (
                <button
                    data-repro-internal="1"
                    onClick={() => {
                        setLoginError(null);
                        setShowLogin(true);
                    }}
                    style={loginButtonStyle}
                >
                    {loginLabel}
                </button>
            )}
            {showLogin && (
                <div
                    data-repro-internal="1"
                    style={modalOverlayStyle}
                    onClick={(evt) => {
                        if (evt.target === evt.currentTarget && !isLoggingIn) {
                            setShowLogin(false);
                        }
                    }}
                >
                    <div data-repro-internal="1" style={modalStyle}>
                        <h3 style={{ margin: 0, marginBottom: 12, fontSize: 18, color: "#0f172a" }}>
                            Authenticate to start recording
                        </h3>
                        <form onSubmit={handleLoginSubmit}>
                            <label style={labelStyle} htmlFor="repro-login-email">
                                Email
                            </label>
                            <input
                                id="repro-login-email"
                                data-repro-internal="1"
                                style={inputStyle}
                                type="email"
                                value={loginEmail}
                                placeholder="user@example.com"
                                onChange={(evt) => {
                                    setLoginEmail(evt.target.value);
                                    setLoginError(null);
                                }}
                                autoComplete="email"
                                required
                            />
                            <label style={labelStyle} htmlFor="repro-login-token">
                                Token
                            </label>
                            <input
                                id="repro-login-token"
                                data-repro-internal="1"
                                style={inputStyle}
                                type="text"
                                value={loginToken}
                                placeholder="Paste your access token"
                                onChange={(evt) => {
                                    setLoginToken(evt.target.value);
                                    setLoginError(null);
                                }}
                                autoComplete="off"
                                required
                            />
                            {loginError && (
                                <div
                                    style={{
                                        color: "#b91c1c",
                                        background: "#fee2e2",
                                        borderRadius: 8,
                                        padding: "8px 12px",
                                        fontSize: 13,
                                        marginBottom: 12,
                                    }}
                                >
                                    {loginError}
                                </div>
                            )}
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
                                <button
                                    type="button"
                                    data-repro-internal="1"
                                    onClick={() => {
                                        if (!isLoggingIn) setShowLogin(false);
                                    }}
                                    style={{
                                        padding: "10px 16px",
                                        borderRadius: 6,
                                        border: "1px solid transparent",
                                        background: "transparent",
                                        color: "#4b5563",
                                        fontWeight: 600,
                                        cursor: isLoggingIn ? "not-allowed" : "pointer",
                                    }}
                                    disabled={isLoggingIn}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    data-repro-internal="1"
                                    style={{
                                        padding: "10px 16px",
                                        borderRadius: 6,
                                        border: "none",
                                        background: disableLogin ? "#d1d5db" : "#2563eb",
                                        color: disableLogin ? "#6b7280" : "#ffffff",
                                        fontWeight: 700,
                                        cursor: disableLogin ? "not-allowed" : "pointer",
                                        transition: "background 0.2s ease",
                                    }}
                                    disabled={disableLogin}
                                >
                                    {isLoggingIn ? "Signing in..." : "Sign in"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}

export default ReproProvider;
