import { PropsWithChildren } from 'react';
import '../styles/record-button.css';

export interface RecordButtonProps {
  disabled?: boolean;
  isRecording?: boolean;
  onClick?: () => void;
  subtext?: string;
}

export function RecordButton({
  disabled,
  isRecording,
  onClick,
  subtext,
  children
}: PropsWithChildren<RecordButtonProps>) {
  return (
    <button
      type="button"
      className={`record-button${isRecording ? ' recording' : ''}`}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={isRecording}
    >
      <span className="record-indicator" aria-hidden />
      <span className="record-button-label">
        {children}
        {subtext ? <span className="subtext">{subtext}</span> : null}
      </span>
    </button>
  );
}
