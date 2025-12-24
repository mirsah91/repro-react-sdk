# Repro React SDK

Capture user sessions with rrweb, tie network requests to user actions, and share a viewer link for fast debugging.

## Install

```bash
npm i repro-react rrweb
# or
yarn add repro-react rrweb
# or
pnpm add repro-react rrweb
```

Peer requirements:
- react >= 17
- react-dom >= 17
- rrweb >= 1 < 2

## Configure

1) Get your `appId` and `tenantId` from Repro.
2) Wrap your app with the provider.

```tsx
import ReproProvider from "repro-react";

export default function App() {
  return (
    <ReproProvider appId="app_123" tenantId="tenant_abc">
      <YourApp />
    </ReproProvider>
  );
}
```

Optional configuration and full interface coverage:

```tsx
import ReproProvider, { attachAxios, type MaskingOptions } from "repro-react";
import axios from "axios";

const masking: MaskingOptions = {
  maskAllInputs: true,
  maskTextSelector: ".pii",
  maskInputOptions: { password: true },
};

const api = axios.create({ baseURL: "https://api.example.com" });
attachAxios(api);

export default function App() {
  return (
    <ReproProvider
      appId="app_123"
      tenantId="tenant_abc"
      apiBase="https://repro.example.com"
      button={{ text: "Report issue" }}
      masking={masking}
    >
      <YourApp />
    </ReproProvider>
  );
}
```

Notes:
- `apiBase` defaults to `http://localhost:4000`.
- `button.text` overrides the floating button label (same label for Record and Stop).
- `attachAxios` works with any Axios instance; `window.axios` is auto-attached if present.
- This SDK runs in the browser; for Next.js use a client component.

## Run

1) Start your app (for example, `npm run dev`).
2) Open the page and click "Authenticate to Record".
3) Sign in with your Repro user credentials.
4) Click "Record", reproduce the issue, then click "Stop & Report".

## Verify it works

- The floating controls appear at the bottom right. "Stop & Report" is visible while recording.
- After stopping, a share card appears with a viewer link you can copy.
- In DevTools -> Network, app requests include `X-Bug-Session-Id` and `X-Bug-Action-Id` while recording.
- Requests to your `apiBase` succeed (for example, `POST /v1/sessions` and `POST /v1/sessions/:id/finish`).

## API

### ReproProvider

```ts
type Props = {
  appId: string;
  tenantId: string;
  apiBase?: string; // default: http://localhost:4000
  children: React.ReactNode;
  button?: { text?: string };
  masking?: MaskingOptions;
};
```

### attachAxios

```ts
attachAxios(axiosInstance: any): void
```

Attach request/response interceptors to an Axios instance so it can inject
`X-Bug-Session-Id` and `X-Bug-Action-Id` during active recordings.

### MaskingOptions

Supported rrweb masking options:
- `maskAllInputs`
- `maskTextClass`
- `maskTextSelector`
- `maskInputOptions`
- `maskInputFn`
- `maskTextFn`
