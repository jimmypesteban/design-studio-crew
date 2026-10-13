import path from 'node:path';
import readline from 'node:readline/promises';
import { clean } from '../plain.ts';
import type { Button, Channel } from './types.ts';

export interface MockChannelOptions {
  /**
   * Scripted answers, used in order. For ask() give a button id. For askText()
   * give the reply text. When the script runs out the mock approves.
   */
  script?: string[];
  /** Read answers from the terminal instead. */
  interactive?: boolean;
  /** Print the chat to the terminal. */
  print?: boolean;
}

/** A terminal stand-in for Telegram that also keeps a transcript for the job folder. */
export class MockChannel implements Channel {
  readonly transcript: string[] = [];
  private script: string[];
  private rl?: readline.Interface;

  constructor(private opts: MockChannelOptions = {}) {
    this.script = [...(opts.script ?? [])];
    if (opts.interactive) this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  close(): void {
    this.rl?.close();
  }

  private out(line: string): void {
    this.transcript.push(line);
    if (this.opts.print !== false) console.log(line);
  }

  /** Jimmy's side of the chat, for the transcript. */
  me(text: string): void {
    this.out(`\nJimmy: ${clean(text)}`);
  }

  async say(text: string): Promise<void> {
    this.out(`\nStudio: ${clean(text)}`);
  }

  async sendFile(filePath: string, caption?: string): Promise<void> {
    this.out(`\nStudio sent a file: ${path.basename(filePath)}${caption ? `\n  ${clean(caption)}` : ''}`);
  }

  async ask(text: string, buttons: Button[]): Promise<string> {
    const row = buttons.map((b, i) => `[${i + 1}] ${b.label}`).join('   ');
    this.out(`\nStudio: ${clean(text)}\n  Buttons: ${row}`);
    let id: string | undefined;
    if (this.rl) {
      for (;;) {
        const a = (await this.rl.question('  Press a button (number): ')).trim();
        const n = Number(a);
        if (Number.isInteger(n) && buttons[n - 1]) {
          id = buttons[n - 1]!.id;
          break;
        }
      }
    } else {
      const next = this.script.shift();
      id = next && buttons.some((b) => b.id === next) ? next : (buttons.find((b) => b.id === 'approve') ?? buttons[0]!).id;
    }
    const label = buttons.find((b) => b.id === id)?.label ?? id;
    this.out(`  Jimmy pressed: ${label}`);
    return id;
  }

  async askText(prompt: string): Promise<string> {
    this.out(`\nStudio: ${clean(prompt)}`);
    let reply: string;
    if (this.rl) reply = (await this.rl.question('  Your reply: ')).trim();
    else reply = this.script.shift() ?? 'Please make it a little simpler.';
    this.out(`  Jimmy: ${reply}`);
    return reply;
  }
}
