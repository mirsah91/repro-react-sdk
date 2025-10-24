import { useCallback, useMemo, useState } from 'react';
import { AuthModal, AuthFormValues } from './components/AuthModal';
import { RecordButton } from './components/RecordButton';
import { useLocalStorage } from './hooks/useLocalStorage';
import './styles/app.css';

interface AuthPayload {
  email: string;
  token: string;
  userData: unknown;
}

const AUTH_STORAGE_KEY = 'app-user-auth';
const LOGIN_ENDPOINT =
  'http://localhost:4000/v1/apps/APP_bddcadcb-c70f-45fa-90f6-56413786f9b3/users/login';

function App() {
  const { value: auth, setValue: setAuth, remove: clearAuth } = useLocalStorage<AuthPayload | null>(
    AUTH_STORAGE_KEY,
    null
  );

  const [isModalOpen, setModalOpen] = useState(false);
  const [isRecording, setRecording] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [isValidating, setValidating] = useState(false);

  const isAuthenticated = useMemo(() => Boolean(auth?.token), [auth]);

  const handleAuthenticate = useCallback(
    async ({ email, token }: AuthFormValues) => {
      setValidating(true);
      try {
        const response = await fetch(LOGIN_ENDPOINT, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'x-app-user-token': token
          },
          body: JSON.stringify({ email, token })
        });

        if (!response.ok) {
          throw new Error('Authentication failed. Please verify your credentials.');
        }

        const payload = (await response.json()) as unknown;
        setAuth({ email, token, userData: payload });
        setStatusMessage('Authenticated. You can start recording.');
      } catch (error) {
        setStatusMessage('Authentication failed. Please try again.');
        if (error instanceof Error) {
          throw error;
        }
        throw new Error('Unexpected authentication error.');
      } finally {
        setValidating(false);
      }
    },
    [setAuth]
  );

  const handleLogout = useCallback(() => {
    clearAuth();
    setRecording(false);
    setStatusMessage('Logged out.');
  }, [clearAuth]);

  const handleRecord = useCallback(() => {
    if (!isAuthenticated) {
      setModalOpen(true);
      return;
    }

    setRecording((current) => {
      const nextState = !current;
      setStatusMessage(nextState ? 'Recording in progress…' : 'Recording paused.');
      return nextState;
    });
  }, [isAuthenticated]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Session Recorder</h1>
          <p className="subtitle">Authenticate to start capturing high-quality session data.</p>
        </div>
        <div className="header-actions">
          {isAuthenticated ? (
            <div className="user-chip" aria-live="polite">
              <span className="user-indicator" aria-hidden />
              <div className="user-text">
                <span className="user-email">{auth?.email}</span>
                <span className="user-subtext">Ready to record</span>
              </div>
              <button type="button" className="logout-button" onClick={handleLogout}>
                Log out
              </button>
            </div>
          ) : (
            <button type="button" className="login-button" onClick={() => setModalOpen(true)}>
              Log in
            </button>
          )}
        </div>
      </header>

      <main className="app-main">
        <section className="record-panel">
          <RecordButton
            isRecording={isRecording}
            disabled={!isAuthenticated || isValidating}
            onClick={handleRecord}
            subtext={isAuthenticated ? (isRecording ? 'Tap to pause' : 'Tap to begin') : 'Log in required'}
          >
            {isRecording ? 'Recording…' : 'Start recording'}
          </RecordButton>

          <p className="status-message" role="status">
            {isValidating
              ? 'Validating your credentials…'
              : statusMessage ||
                (isAuthenticated
                  ? 'You are authenticated. Press record to begin.'
                  : 'Please log in to enable the recorder.')}
          </p>
        </section>
      </main>

      <AuthModal
        isOpen={isModalOpen}
        onClose={() => {
          if (!isValidating) {
            setModalOpen(false);
          }
        }}
        onSubmit={handleAuthenticate}
      />
    </div>
  );
}

export default App;
