/** A reversible edit. */
export interface Command {
  label: string;
  undo(): void;
  redo(): void;
}

/** Undo/redo stack. Commands are pushed already applied. */
export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  limit: number;
  onChange: () => void = () => {};

  constructor(limit = 200) {
    this.limit = limit;
  }

  push(cmd: Command): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange();
  }

  /** Applies a command and records it. */
  run(cmd: Command): void {
    cmd.redo();
    this.push(cmd);
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    this.onChange();
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.redo();
    this.undoStack.push(cmd);
    this.onChange();
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange();
  }
}

/**
 * Collects voxel changes on one grid during a stroke. Only the first old value
 * per cell is kept, so a drag that touches a cell twice still undoes cleanly.
 */
export class VoxelEdit {
  private changes = new Map<number, [number, number]>();
  constructor(readonly data: Uint8Array) {}

  set(i: number, v: number): boolean {
    const old = this.data[i];
    if (old === v) return false;
    const prev = this.changes.get(i);
    this.changes.set(i, [prev ? prev[0] : old, v]);
    this.data[i] = v;
    return true;
  }

  get size(): number {
    return this.changes.size;
  }

  toCommand(label: string, after: () => void): Command | null {
    // Drop cells that ended up back at their original value
    const entries = [...this.changes].filter(([, [a, b]]) => a !== b);
    if (entries.length === 0) return null;
    const data = this.data;
    return {
      label,
      undo() {
        for (const [i, [old]] of entries) data[i] = old;
        after();
      },
      redo() {
        for (const [i, [, v]] of entries) data[i] = v;
        after();
      },
    };
  }
}
