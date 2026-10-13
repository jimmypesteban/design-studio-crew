export interface Button {
  id: string;
  label: string;
}

/**
 * Everything the studio needs from Telegram. The pipeline only talks to this,
 * so the mock and the real bot are interchangeable.
 */
export interface Channel {
  /** Plain message. */
  say(text: string): Promise<void>;
  /** Send a file (HTML, image, markdown). */
  sendFile(filePath: string, caption?: string): Promise<void>;
  /** Message with inline buttons. Resolves with the id of the button pressed. */
  ask(text: string, buttons: Button[]): Promise<string>;
  /** Wait for the next free text reply. */
  askText(prompt: string): Promise<string>;
}

export const APPROVE: Button = { id: 'approve', label: 'Approve' };
export const REJECT: Button = { id: 'reject', label: 'Send back with a reason' };
export const STOP: Button = { id: 'stop', label: 'Stop this job' };
