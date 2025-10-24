import { FormEvent, useState } from 'react';
import '../styles/modal.css';

export interface AuthFormValues {
  email: string;
  token: string;
}

export interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (values: AuthFormValues) => Promise<void>;
}

export function AuthModal({ isOpen, onClose, onSubmit }: AuthModalProps) {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await onSubmit({ email, token });
      setEmail('');
      setToken('');
      onClose();
    } catch (submitError) {
      if (submitError instanceof Error) {
        setError(submitError.message);
      } else {
        setError('Unable to authenticate. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
      <div className="modal-content">
        <div className="modal-header">
          <h2 id="auth-modal-title" className="modal-title">
            Log in to start recording
          </h2>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close login modal">
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          <div className="input-field">
            <label htmlFor="auth-email">Email address</label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              placeholder="user@example.com"
            />
          </div>

          <div className="input-field">
            <label htmlFor="auth-token">Token</label>
            <input
              id="auth-token"
              type="text"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              required
              autoComplete="off"
              placeholder="Paste your access token"
            />
          </div>

          {error ? <p className="error-message">{error}</p> : null}

          <div className="modal-actions">
            <button className="button-secondary" type="button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button className="button-primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Authenticating…' : 'Authenticate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
