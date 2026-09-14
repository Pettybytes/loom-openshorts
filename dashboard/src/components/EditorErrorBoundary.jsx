import React from 'react';

// Route-level error boundary for the LOOM editor. No input, API, or render
// exception may ever produce a blank page: any uncaught error inside the editor
// subtree is caught here and surfaced as a recoverable error that preserves the
// user's draft (the draft is persisted server-side before render and restored
// on reload via the authenticated session).
export default class EditorErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Do NOT log the URL (it may briefly carry the single-use launch token).
    console.error('[editor] render error caught by boundary:', error && error.message, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-paper text-ink2 flex items-center justify-center p-6">
          <div className="max-w-md w-full card p-6 space-y-4">
            <h1 className="font-display lowercase text-2xl text-ink">editor hit an error</h1>
            <p className="text-sm text-muted">
              Something went wrong, but your draft is safe. Reload to restore it and keep going.
            </p>
            <p className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg p-3 break-words">
              {String(this.state.error?.message || this.state.error)}
            </p>
            <button
              onClick={() => { try { window.location.reload(); } catch (_) {} }}
              className="btn-primary px-4 py-2 w-full"
            >
              Reload editor
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
