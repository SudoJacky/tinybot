// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AutomationRun, AutomationSnapshot, AutomationStore, SavedAutomation } from '../../app-core/native/desktopNativeAutomations';
import { AppToastViewport, dismissAppToast } from '../lib/AppToast';
import { useMissedAutomationNotice } from './useMissedAutomationNotice';

beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); });
afterEach(() => { cleanup(); dismissAppToast(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
 const definition: SavedAutomation = { id: 'weekly', name: 'Weekly report', instructions: 'Write report.md', workspacePath: 'D:/project', revision: 1, modelPolicy: 'inherit_default', updatedAtMs: 1 };
 const missed: AutomationRun = { id: 'missed-1', definition, status: 'missed', effectiveModel: null, threadId: null, error: null, startedAtMs: 100, scheduledAtMs: 50, finishedAtMs: 100, stopReason: 'scheduler_unavailable' };
 const snapshot: AutomationSnapshot = { definitions: [definition], runs: [missed] };
 const store: AutomationStore = { list: vi.fn(async () => snapshot), run: vi.fn(), save: vi.fn(), delete: vi.fn(), output: vi.fn() };
 return { store, snapshot, missed };
}
async function mount(store: AutomationStore, open = vi.fn()) {
 let hook!: ReturnType<typeof renderHook>;
 await act(async () => {
   render(<AppToastViewport />);
   hook = renderHook(() => useMissedAutomationNotice(store, open));
 });
 return hook;
}

it('reminds globally, opens tasks without executing, and does not repeat after remount', async () => {
 const { store } = fixture(); const open = vi.fn();
 await mount(store, open);
 expect(screen.getByRole('status').textContent).toContain('Weekly report');
 expect(screen.getByRole('status').parentElement?.dataset.tone).toBe('warning');
 fireEvent.click(screen.getByRole('button', { name: 'View tasks' }));
 expect(open).toHaveBeenCalledOnce();
 expect(store.run).not.toHaveBeenCalled();
 expect(screen.queryByRole('status')).toBeNull();
 await act(async () => { vi.advanceTimersByTime(10000); });
 expect(screen.queryByRole('status')).toBeNull();
 cleanup();
 await mount(store, open);
 expect(screen.queryByRole('status')).toBeNull();
});

it('aggregates newly missed tasks and notices later occurrences once', async () => {
 const { store, snapshot, missed } = fixture();
 snapshot.definitions.push({ ...snapshot.definitions[0], id: 'daily', name: 'Daily report' });
 snapshot.runs.push({ ...missed, id: 'missed-2', definition: snapshot.definitions[1] });
 await mount(store);
 expect(screen.getByRole('status').textContent).toContain('2 scheduled tasks');
 act(() => dismissAppToast());
 snapshot.runs.unshift({ ...missed, id: 'missed-next-week', startedAtMs: 200 });
 await act(async () => { vi.advanceTimersByTime(10000); });
 expect(screen.getByRole('status').textContent).toContain('Weekly report');
 expect(screen.getByRole('status').textContent).not.toContain('2 scheduled');
});

it('does not remind for deleted tasks or misses superseded by a new run', async () => {
 const { store, snapshot, missed } = fixture();
 snapshot.runs.unshift({ ...missed, id: 'manual-run', status: 'completed' });
 snapshot.runs.push({ ...missed, id: 'deleted-miss', definition: { ...missed.definition, id: 'deleted' } });
 await mount(store);
 expect(screen.queryByRole('status')).toBeNull();
});

it('waits until the window is visible before fetching and acknowledging misses', async () => {
 const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
 const { store } = fixture();
 await mount(store);
 expect(store.list).not.toHaveBeenCalled();
 expect(window.localStorage.length).toBe(0);
 hidden.mockReturnValue(false);
 await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
 expect(screen.getByRole('status').textContent).toContain('Weekly report');
 expect(window.localStorage.length).toBe(1);
});

it('keeps failures visible, stops repeated polling, and retries on window focus', async () => {
 const { store } = fixture();
 vi.mocked(store.list).mockRejectedValueOnce(new Error('Store unavailable'));
 const log = vi.spyOn(console, 'error').mockImplementation(() => {});
 await mount(store);
 expect(screen.getByRole('alert').textContent).toContain('Store unavailable');
 expect(log).toHaveBeenCalledOnce();
 expect(window.localStorage.length).toBe(0);
 await act(async () => { vi.advanceTimersByTime(30000); });
 expect(store.list).toHaveBeenCalledOnce();
 await act(async () => { window.dispatchEvent(new Event('focus')); });
 expect(screen.getByRole('status').textContent).toContain('Weekly report');
});

it('ignores a store response arriving after unmount', async () => {
 const { store, snapshot } = fixture();
 let resolve!: (value: AutomationSnapshot) => void;
 vi.mocked(store.list).mockImplementation(() => new Promise((done) => { resolve = done; }));
 const hook = await mount(store);
 hook.unmount();
 await act(async () => { resolve(snapshot); });
 expect(screen.queryByRole('status')).toBeNull();
 expect(window.localStorage.length).toBe(0);
});
