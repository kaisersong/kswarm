import { useState } from 'react';

export function CreateTask({ onSubmit }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(title.trim());
      setTitle('');
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-dashed border-zinc-700 text-zinc-400 text-xs hover:border-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <span className="text-base leading-none">+</span>
        New Task
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        autoFocus
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task description..."
        className="flex-1 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
        disabled={submitting}
      />
      <button
        type="submit"
        disabled={!title.trim() || submitting}
        className="px-3 py-1.5 rounded-lg bg-indigo-600 text-xs text-white font-medium hover:bg-indigo-500 disabled:opacity-40 transition-colors"
      >
        Send
      </button>
      <button
        type="button"
        onClick={() => { setOpen(false); setTitle(''); }}
        className="px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-300"
      >
        Cancel
      </button>
    </form>
  );
}
