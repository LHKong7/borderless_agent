/**
 * todoCore.ts - Todo list manager.
 */

export interface TodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
}

export class TodoManager {
    items: TodoItem[] = [];

    update(items: any[]): string {
        const validated: TodoItem[] = [];
        let inProgress = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const content = String(item.content ?? '').trim();
            const status = String(item.status ?? 'pending').toLowerCase() as TodoItem['status'];
            const activeForm = String(item.activeForm ?? '').trim();

            if (!content || !activeForm) {
                throw new Error(`Item ${i}: content and activeForm required`);
            }
            if (!['pending', 'in_progress', 'completed'].includes(status)) {
                throw new Error(`Item ${i}: invalid status`);
            }
            if (status === 'in_progress') {
                inProgress++;
            }

            validated.push({ content, status, activeForm });
        }

        if (inProgress > 1) {
            throw new Error('Only one task can be in_progress');
        }

        this.items = validated.slice(0, 20);
        return this.render();
    }

    render(): string {
        if (this.items.length === 0) return 'No todos.';

        const lines: string[] = [];
        for (const t of this.items) {
            const mark =
                t.status === 'completed'
                    ? '[x]'
                    : t.status === 'in_progress'
                        ? '[>]'
                        : '[ ]';
            lines.push(`${mark} ${t.content}`);
        }
        const done = this.items.filter((t) => t.status === 'completed').length;
        return lines.join('\n') + `\n(${done}/${this.items.length} done)`;
    }
}

export const TODO = new TodoManager();
