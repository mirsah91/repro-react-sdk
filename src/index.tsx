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

type RrwebRecordOptions = NonNullable<Parameters<typeof record>[0]>;
export type MaskingOptions = Pick<
    RrwebRecordOptions,
    "maskAllInputs" | "maskTextClass" | "maskTextSelector" | "maskInputOptions" | "maskInputFn" | "maskTextFn"
>;

type Props = {
    appId: string;
    tenantId: string;
    apiBase?: string; // default: http://localhost:4000
    children: React.ReactNode;
    button?: { text?: string }; // optional override label
    masking?: MaskingOptions;
};

// config
const MAX_BYTES = 900 * 1024; // 900 KB target per POST (tune)
const SESSION_MAX_MS = 60 * 1000; // cap each session at 1 minute

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
const NGROK_SKIP_HEADER = "ngrok-skip-browser-warning";
const NGROK_SKIP_VALUE = "true";

// --- manual Axios attach support (module-scoped ctx) ---
type ReproCtx = {
    base: string;
    getSid: () => string | null;
    getAid: () => string | null;
    getToken: () => string | null;
    getUserToken: () => string | null;
    getUserPassword: () => string | null;
    getTenantId: () => string | null;
    getFetch: () => typeof window.fetch;
    hasReqMarked: Set<string>;
    onUnauthorized?: () => void;
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
        const sdkToken = ctx.getToken();
        const userToken = ctx.getUserToken();
        if (isInternal) {
            setHeader(NGROK_SKIP_HEADER, NGROK_SKIP_VALUE);
            if (tenantId) {
                setHeader(TENANT_HEADER, tenantId);
            }
            if (sdkToken && !(config.headers as any)["x-sdk-token"]) {
                setHeader("x-sdk-token", sdkToken);
            }
            const existingAuth =
                (config.headers as any)?.Authorization ??
                (config.headers as any)?.authorization;
            if (userToken && !existingAuth) {
                setHeader("Authorization", `Bearer ${userToken}`);
            }
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
            if (isInternal && resp.status === 401) {
                ctx.onUnauthorized?.();
            }

            const sid = ctx.getSid();
            const aid = ctx.getAid();
            if (!isInternal && !isSdkInternal && sid && aid && !ctx.hasReqMarked.has(aid)) {
                ctx.hasReqMarked.add(aid);
            }
            return resp;
        },
        (err: any) => {
            const ctx = __reproCtx;
            if (ctx) {
                const status = err?.response?.status;
                const url = `${err?.config?.baseURL || ""}${err?.config?.url || ""}`;
                if (status === 401 && url.startsWith(ctx.base)) {
                    ctx.onUnauthorized?.();
                }
            }
            return Promise.reject(err);
        }
    );
}

type ActionMeta = { tStart: number; label?: string };

export function ReproProvider({ appId, tenantId, apiBase, children, button, masking }: Props) {
    const base = apiBase || "http://localhost:4000";
type StoredAuth = {
    email: string;
    password?: string | null;
    token: string;
    data: any;
} | null;
    const storageKey = `repro-auth-${tenantId}-${appId}`;

    const initialAuth: StoredAuth = (() => {
        if (typeof window === "undefined") return null;
        try {
            const raw = window.localStorage.getItem(storageKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") return null;
            const email = typeof parsed.email === "string" ? parsed.email : null;
            const password = typeof parsed.password === "string" ? parsed.password : null;
            const token =
                typeof parsed.token === "string" && parsed.token.trim().length
                    ? (parsed.token as string).trim()
                    : null;
            if (!email || !token) return null;
            return {
                email,
                password,
                token,
                data: (parsed as any).data,
            };
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
    const sessionExpiryTimerRef = useRef<number | null>(null);
    const origFetchRef = useRef<typeof window.fetch>();
    const hasReqMarkedRef = useRef<Set<string>>(new Set());
    const lastActionLabelRef = useRef<string | null>(null);
    const actionMeta = useRef<Map<string, ActionMeta>>(new Map());
    const nextSeqRef = useRef<number>(1); // rrweb chunk counter
    const isFlushingRef = useRef(false);
    const backoffRef = useRef(0); // ms
    const isStoppingRef = useRef(false);

    // NEW: track installed click handler + dedupe recent clicks
    const clickHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);
    const lastClickRef = useRef<{ t: number; label: string } | null>(null);

    const [ready, setReady] = useState(false);
    const [recording, setRecording] = useState(false);
    const [auth, setAuth] = useState<StoredAuth>(initialAuth);
    const userPasswordRef = useRef<string | null>(initialAuth?.password ?? null);
    const userTokenRef = useRef<string | null>(initialAuth?.token ?? null);
    const tenantIdRef = useRef<string>(tenantId);
    const [showLogin, setShowLogin] = useState(false);
    const [loginEmail, setLoginEmail] = useState(initialAuth?.email ?? "");
    const [loginPassword, setLoginPassword] = useState(initialAuth?.password ?? "");
    const [loginError, setLoginError] = useState<string | null>(null);
    const [isLoggingIn, setIsLoggingIn] = useState(false);
    const disableLogin = isLoggingIn || !loginEmail.trim() || !loginPassword.trim();
    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
    const copyStatusTimerRef = useRef<number | null>(null);
    const logoutInFlightRef = useRef(false);
    const authCheckInFlightRef = useRef(false);
    const lastAuthCheckTokenRef = useRef<string | null>(null);
    const [controlsHidden, setControlsHidden] = useState(false);
    const [showHiddenNotice, setShowHiddenNotice] = useState(true);
    const shortcutKeysRef = useRef<Set<string>>(new Set());
    const clearCopyStatusTimer = () => {
        if (copyStatusTimerRef.current == null) return;
        if (typeof window !== "undefined") {
            window.clearTimeout(copyStatusTimerRef.current);
        } else {
            clearTimeout(copyStatusTimerRef.current);
        }
        copyStatusTimerRef.current = null;
    };
    const resetCopyFeedback = () => {
        clearCopyStatusTimer();
        setCopyStatus("idle");
    };
    const clearShareInfo = () => {
        setShareUrl(null);
        resetCopyFeedback();
    };
    const setCopyStatusWithTimeout = (status: "idle" | "copied" | "error") => {
        clearCopyStatusTimer();
        setCopyStatus(status);
        if (status === "idle") return;
        if (typeof window !== "undefined") {
            copyStatusTimerRef.current = window.setTimeout(() => {
                setCopyStatus("idle");
                copyStatusTimerRef.current = null;
            }, 2200);
        }
    };

    const clearSessionExpiryTimer = () => {
        if (sessionExpiryTimerRef.current == null) return;
        if (typeof window !== "undefined") {
            window.clearTimeout(sessionExpiryTimerRef.current);
        } else {
            clearTimeout(sessionExpiryTimerRef.current);
        }
        sessionExpiryTimerRef.current = null;
    };

    const addTenantHeader = (headers: Record<string, string>) => {
        const tenant = tenantIdRef.current;
        const next: Record<string, string> = {
            ...headers,
            [NGROK_SKIP_HEADER]: NGROK_SKIP_VALUE,
        };
        if (tenant) {
            next[TENANT_HEADER] = tenant;
        }
        return next;
    };

    const setTenantOnHeaders = (headers: Headers, isInternal?: boolean) => {
        if (isInternal) {
            headers.set(NGROK_SKIP_HEADER, NGROK_SKIP_VALUE);
        }
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
        getUserPassword: () => userPasswordRef.current,
            getTenantId: () => tenantIdRef.current,
            getFetch: () => (origFetchRef.current ?? window.fetch.bind(window)),
            hasReqMarked: hasReqMarkedRef.current,
            onUnauthorized: () => handleUnauthorized(),
        };
        return () => {
            __reproCtx = null;
        };
    }, [base, tenantId]);

    useEffect(() => {
        if (!auth?.token) {
            lastAuthCheckTokenRef.current = null;
            return;
        }
        if (
            authCheckInFlightRef.current ||
            lastAuthCheckTokenRef.current === auth.token
        ) {
            return;
        }
        let cancelled = false;
        authCheckInFlightRef.current = true;
        lastAuthCheckTokenRef.current = auth.token;

        (async () => {
            try {
                const fetcher = origFetchRef.current ?? window.fetch.bind(window);
                const resp = await fetcher(`${base}/v1/apps/${appId}/users/me`, {
                    method: "GET",
                    headers: addTenantHeader({
                        Accept: "application/json",
                        Authorization: `Bearer ${auth.token}`,
                        [INTERNAL_HEADER]: "1",
                    }),
                });
                if (!cancelled && !resp.ok) {
                    handleUnauthorized();
                }
            } catch {
                if (!cancelled) {
                    handleUnauthorized();
                }
            } finally {
                authCheckInFlightRef.current = false;
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [auth, appId, base]);

    useEffect(() => {
        userPasswordRef.current = auth?.password ?? null;
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

    async function login(email: string, password: string) {
        setIsLoggingIn(true);
        setLoginError(null);
        try {
            const resp = await fetch(`${base}/v1/apps/${appId}/users/login`, {
                method: "POST",
                headers: addTenantHeader({
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    [INTERNAL_HEADER]: "1",
                }),
                body: JSON.stringify({ email, password }),
            });
            if (!resp.ok) {
                throw new Error(`Login failed (${resp.status})`);
            }
            const data = await resp.json();
            const accessTokenFromUser =
                typeof data?.user?.accessToken === "string"
                    ? (data.user.accessToken as string).trim()
                    : null;
            const accessTokenFromData =
                typeof data?.accessToken === "string"
                    ? (data.accessToken as string).trim()
                    : null;
            const accessToken = accessTokenFromUser || accessTokenFromData;
            if (!accessToken) {
                throw new Error("Login response did not include an access token.");
            }
            setAuth({ email, password, token: accessToken, data });
            setLoginPassword("");
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
        login(loginEmail.trim(), loginPassword.trim());
    }

    async function logout(options?: { showLogin?: boolean }) {
        if (logoutInFlightRef.current) return;
        logoutInFlightRef.current = true;
        try {
            if (recording && !isStoppingRef.current) {
                try {
                    await stop();
                } catch {
                    /* ignore */
                }
            }
            setAuth(null);
            setLoginPassword("");
            clearShareInfo();
            setShowLogin(options?.showLogin ?? false);
        } finally {
            logoutInFlightRef.current = false;
        }
    }

    function handleUnauthorized() {
        void logout({ showLogin: true });
    }

    const handleUnauthorizedStatus = (status?: number | null) => {
        if (status === 401) {
            handleUnauthorized();
            return true;
        }
        return false;
    };

    useEffect(() => {
        if (!showLogin) {
            setLoginError(null);
        }
    }, [showLogin]);

    useEffect(() => {
        return () => {
            clearCopyStatusTimer();
            clearSessionExpiryTimer();
        };
    }, []);

    useEffect(() => {
        const pressed = shortcutKeysRef.current;
        if (typeof window === "undefined") return;
        const handleKeyDown = (evt: KeyboardEvent) => {
            const hasMod = evt.ctrlKey || evt.metaKey;
            if (!hasMod) {
                pressed.clear();
                return;
            }
            const key = (evt.key || "").toLowerCase();
            if (key === "r" || key === "o") {
                pressed.add(key);
                const combo = pressed.has("r") && pressed.has("o");
                if (combo) {
                    if (controlsHidden) {
                        evt.preventDefault();
                    }
                    setControlsHidden(false);
                    setShowHiddenNotice(false);
                    pressed.clear();
                    return;
                }
                if (controlsHidden) {
                    evt.preventDefault();
                }
                return;
            }
            if (key === "control" || key === "meta") {
                pressed.clear();
                return;
            }
            pressed.clear();
        };
        const handleKeyUp = (evt: KeyboardEvent) => {
            const key = (evt.key || "").toLowerCase();
            if (key === "r" || key === "o") {
                pressed.delete(key);
            } else if (key === "control" || key === "meta") {
                pressed.clear();
            }
        };
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("keyup", handleKeyUp, true);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("keyup", handleKeyUp, true);
        };
    }, [controlsHidden]);

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
                    "x-sdk-token": token,
                    ...(userTokenRef.current ? { Authorization: `Bearer ${userTokenRef.current}` } : {}),
                    [INTERNAL_HEADER]: "1",
                }),
                body: gz,
            });
            if (handleUnauthorizedStatus(r.status)) return 'fail';
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
                    "x-sdk-token": token,
                    ...(userTokenRef.current ? { Authorization: `Bearer ${userTokenRef.current}` } : {}),
                    [INTERNAL_HEADER]: "1",
                }),
                body: JSON.stringify({ ...envelope, seq }), // ensure seq matches piece
            });
            if (handleUnauthorizedStatus(r.status)) return 'fail';
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

            if (isInternal) {
                config.headers = config.headers || {};
                config.headers[NGROK_SKIP_HEADER] = NGROK_SKIP_VALUE;
                if (tenantIdRef.current) {
                    config.headers[TENANT_HEADER] = tenantIdRef.current;
                }
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
                if (isInternal) {
                    handleUnauthorizedStatus(resp.status);
                }

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
                            "x-sdk-token": sdkTokenRef.current as string,
                            ...(userTokenRef.current ? { Authorization: `Bearer ${userTokenRef.current}` } : {}),
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
        clearShareInfo();

        const r = await fetch(`${base}/v1/sessions`, {
            method: "POST",
            headers: addTenantHeader({
                "Content-Type": "application/json",
                "x-sdk-token": sdkTokenRef.current as string,
                ...(userTokenRef.current ? { Authorization: `Bearer ${userTokenRef.current}` } : {}),
            }),
            body: JSON.stringify({ clientTime: nowServer() }),
        });
        if (!r.ok) {
            handleUnauthorizedStatus(r.status);
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
            setTenantOnHeaders(headers, isInternal);
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
            if (isInternal) {
                handleUnauthorizedStatus(res.status);
            }

            // mark hasReq ONCE per action (skip internal/API calls)
            if (
                !isInternal &&
                !isSdkInternal &&
                sessionIdRef.current &&
                currentAidRef.current &&
                !hasReqMarkedRef.current.has(currentAidRef.current)
            ) {
                hasReqMarkedRef.current.add(currentAidRef.current);
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
                        "x-sdk-token": sdkTokenRef.current as string,
                        ...(userTokenRef.current ? { Authorization: `Bearer ${userTokenRef.current}` } : {}),
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
            )
                .then((resp) => {
                    handleUnauthorizedStatus(resp.status);
                })
                .catch(() => {});
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
            ...(masking ?? {}),
        });

        // 5) cleanup registration
        (stop as any)._cleanup = () => {
            if (clickHandlerRef.current) {
                document.removeEventListener("click", clickHandlerRef.current, { capture: true } as any);
                clickHandlerRef.current = null;
            }
        };

        clearSessionExpiryTimer();
        sessionExpiryTimerRef.current = window.setTimeout(() => {
            void stop();
        }, SESSION_MAX_MS);

        setRecording(true);
    }

    // ---- STOP recording ----
    async function stop() {
        clearSessionExpiryTimer();
        if (!recording || isStoppingRef.current) return;
        isStoppingRef.current = true;

        try {
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

                    const chunkRes = await origFetch(`${base}/v1/sessions/${sid}/events`, {
                        method: "POST",
                        headers: addTenantHeader({
                            "Content-Type": "application/json",
                            "x-sdk-token": token,
                            ...(userTokenRef.current ? { Authorization: `Bearer ${userTokenRef.current}` } : {}),
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
                    if (handleUnauthorizedStatus(chunkRes.status)) {
                        break;
                    }
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
                        "x-sdk-token": token,
                        ...(userTokenRef.current ? { Authorization: `Bearer ${userTokenRef.current}` } : {}),
                        [INTERNAL_HEADER]: "1",
                    }),
                    body: JSON.stringify({ notes: "" }),
                });
                if (handleUnauthorizedStatus(res.status)) {
                    clearShareInfo();
                } else if (res.ok) {
                    let fin: any = null;
                    try {
                        fin = await res.json();
                    } catch {
                        fin = null;
                    }
                    if (fin?.viewerUrl) {
                        resetCopyFeedback();
                        setShareUrl(fin.viewerUrl);
                    } else {
                        clearShareInfo();
                    }
                } else {
                    clearShareInfo();
                }
            } catch {
                clearShareInfo();
            }
        } finally {
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
            isStoppingRef.current = false;
        }
    }

    // ---- UI (floating button) ----
    const btnLabel = recording ? (button?.text ?? "Stop & Report") : (button?.text ?? "Record");
    const loginLabel = "Authenticate to Record";

    const floatingContainerBaseStyle: React.CSSProperties = {
        position: "fixed",
        zIndex: 2147483647,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 12,
        width: "100%",
        maxWidth: 360,
    };
    const floatingContainerStyle: React.CSSProperties = {
        ...floatingContainerBaseStyle,
        right: 16,
        bottom: 16,
    };

    const buttonRowStyle: React.CSSProperties = {
        display: "flex",
        gap: 10,
        justifyContent: "flex-end",
        width: "100%",
    };

    const buttonBaseStyle: React.CSSProperties = {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "12px 24px",
        borderRadius: 9999,
        border: "none",
        background: "#f4f5f7",
        cursor: "pointer",
        fontFamily: "ui-sans-serif, system-ui, -apple-system",
        fontSize: "14px",
        fontWeight: 600,
        color: "#ffffff",
        boxShadow: "0 14px 24px rgba(15, 23, 42, 0.18)",
        transition:
            "transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, color 0.2s ease",
        minWidth: 150,
    };

    const recordButtonStyle: React.CSSProperties = {
        ...buttonBaseStyle,
        background: recording
            ? "linear-gradient(120deg, #ef4444, #b91c1c)"
            : "linear-gradient(120deg, #2563eb, #1d4ed8)",
        boxShadow: recording
            ? "0 18px 32px rgba(239, 68, 68, 0.35)"
            : "0 18px 32px rgba(37, 99, 235, 0.35)",
    };

    const loginButtonStyle: React.CSSProperties = {
        ...buttonBaseStyle,
        background: "linear-gradient(120deg, #14b8a6, #0d9488)",
    };

    const logoutButtonStyle: React.CSSProperties = {
        ...buttonBaseStyle,
        background: "#ffffff",
        border: "1px solid #e5e7eb",
        color: "#1f2933",
        boxShadow: "0 10px 18px rgba(15, 23, 42, 0.12)",
    };

    const shareCardStyle: React.CSSProperties = {
        width: "100%",
        background: "#ffffff",
        borderRadius: 16,
        padding: "14px 16px",
        border: "1px solid #e5e7eb",
        boxShadow: "0 20px 36px rgba(15, 23, 42, 0.2)",
        fontFamily: "ui-sans-serif, system-ui, -apple-system",
    };

    const shareLinkStyle: React.CSSProperties = {
        marginTop: 6,
        padding: "8px 10px",
        borderRadius: 10,
        background: "#f3f4f6",
        fontSize: 12,
        color: "#374151",
        wordBreak: "break-all",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    };

    const copyButtonStyle: React.CSSProperties = {
        ...buttonBaseStyle,
        padding: "8px 16px",
        fontSize: 13,
        background: "#111827",
        boxShadow: "none",
        minWidth: 110,
    };

    const hideButtonStyle: React.CSSProperties = {
        border: "none",
        background: "transparent",
        color: "#6b7280",
        cursor: "pointer",
        fontWeight: 700,
        padding: "6px 8px",
        borderRadius: 8,
        fontSize: 12,
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

    const hiddenNoticeStyle: React.CSSProperties = {
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 2147483647,
        maxWidth: 320,
        background: "#111827",
        color: "#e5e7eb",
        borderRadius: 12,
        padding: "12px 14px",
        boxShadow: "0 16px 30px rgba(0, 0, 0, 0.3)",
        fontFamily: "ui-sans-serif, system-ui, -apple-system",
        fontSize: 13,
        lineHeight: 1.4,
    };
    const hiddenNoticeCloseStyle: React.CSSProperties = {
        border: "none",
        background: "transparent",
        color: "#e5e7eb",
        cursor: "pointer",
        fontWeight: 700,
        padding: 0,
        lineHeight: 1,
        fontSize: 14,
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

    const hideControls = () => {
        setControlsHidden(true);
        setShowHiddenNotice(true);
    };

    async function copyShareLink() {
        if (!shareUrl) return;
        const text = shareUrl;
        try {
            if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else if (typeof document !== "undefined") {
                const helper = document.createElement("textarea");
                helper.value = text;
                helper.style.position = "fixed";
                helper.style.opacity = "0";
                helper.style.pointerEvents = "none";
                document.body.appendChild(helper);
                helper.focus();
                helper.select();
                document.execCommand("copy");
                document.body.removeChild(helper);
            } else {
                throw new Error("clipboard unavailable");
            }
            setCopyStatusWithTimeout("copied");
        } catch {
            setCopyStatusWithTimeout("error");
        }
    }

    return (
        <>
            {children}
            {!controlsHidden && (shareUrl || ready) && (
                <div data-repro-internal="1" style={floatingContainerStyle}>
                    <div
                        data-repro-internal="1"
                        style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", width: "100%", gap: 8 }}
                        aria-label="Recording controls header"
                    >
                        <button
                            type="button"
                            data-repro-internal="1"
                            onClick={hideControls}
                            style={hideButtonStyle}
                            aria-label="Hide recording controls"
                        >
                            Hide
                        </button>
                    </div>
                    {shareUrl && (
                        <div data-repro-internal="1" style={shareCardStyle}>
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: 12,
                                    width: "100%",
                                }}
                            >
                                <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>
                                    Latest capture ready to share
                                </div>
                                <button
                                    type="button"
                                    data-repro-internal="1"
                                    onClick={() => clearShareInfo()}
                                    style={{
                                        border: "none",
                                        background: "transparent",
                                        color: "#9ca3af",
                                        cursor: "pointer",
                                        padding: 4,
                                        lineHeight: 1,
                                        fontWeight: 700,
                                        borderRadius: 999,
                                        width: 24,
                                        height: 24,
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                    }}
                                    aria-label="Close share link"
                                >
                                    ×
                                </button>
                            </div>
                            <div style={shareLinkStyle} title={shareUrl}>
                                {shareUrl}
                            </div>
                            <div
                                style={{
                                    marginTop: 10,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: 12,
                                    width: "100%",
                                }}
                            >
                                <span
                                    style={{
                                        fontSize: 12,
                                        minWidth: 100,
                                        color:
                                            copyStatus === "copied"
                                                ? "#059669"
                                                : copyStatus === "error"
                                                ? "#b91c1c"
                                                : "#6b7280",
                                        visibility: copyStatus === "idle" ? "hidden" : "visible",
                                        transition: "color 0.2s ease",
                                    }}
                                >
                                    {copyStatus === "copied"
                                        ? "Link copied!"
                                        : copyStatus === "error"
                                        ? "Unable to copy"
                                        : "placeholder"}
                                </span>
                                <button
                                    type="button"
                                    data-repro-internal="1"
                                    onClick={() => void copyShareLink()}
                                    style={copyButtonStyle}
                                >
                                    {copyStatus === "copied" ? "Copied" : "Copy link"}
                                </button>
                            </div>
                        </div>
                    )}
                    {ready && auth && (
                        <div data-repro-internal="1" style={buttonRowStyle}>
                            <button
                                data-repro-internal="1"
                                onClick={() => (recording ? stop() : start())}
                                style={recordButtonStyle}
                                type="button"
                            >
                                <span
                                    aria-hidden="true"
                                    style={{
                                        width: 10,
                                        height: 10,
                                        borderRadius: "999px",
                                        background: recording ? "#fecaca" : "#bbf7d0",
                                        boxShadow: recording
                                            ? "0 0 12px rgba(239, 68, 68, 0.7)"
                                            : "0 0 10px rgba(16, 185, 129, 0.6)",
                                    }}
                                />
                                {btnLabel}
                            </button>
                            <button
                                data-repro-internal="1"
                                onClick={() => void logout()}
                                style={logoutButtonStyle}
                                type="button"
                            >
                                Log out
                            </button>
                        </div>
                    )}
                    {ready && !auth && (
                        <div data-repro-internal="1" style={buttonRowStyle}>
                            <button
                                data-repro-internal="1"
                                onClick={() => {
                                    setLoginError(null);
                                    setShowLogin(true);
                                }}
                                style={loginButtonStyle}
                                type="button"
                            >
                                {loginLabel}
                            </button>
                        </div>
                    )}
                </div>
            )}
            {controlsHidden && showHiddenNotice && (
                <div data-repro-internal="1" style={hiddenNoticeStyle}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                        <div style={{ fontWeight: 700 }}>Recording controls hidden</div>
                        <button
                            type="button"
                            data-repro-internal="1"
                            style={hiddenNoticeCloseStyle}
                            aria-label="Close hidden controls message"
                            onClick={() => setShowHiddenNotice(false)}
                        >
                            ×
                        </button>
                    </div>
                    <div>Press Ctrl/Cmd + R + O to show them again.</div>
                </div>
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
                            <label style={labelStyle} htmlFor="repro-login-password">
                                Password
                            </label>
                            <input
                                id="repro-login-password"
                                data-repro-internal="1"
                                style={inputStyle}
                                type="password"
                                value={loginPassword}
                                placeholder="Enter your workspace password"
                                onChange={(evt) => {
                                    setLoginPassword(evt.target.value);
                                    setLoginError(null);
                                }}
                                autoComplete="current-password"
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
