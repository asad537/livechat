import React from 'react';

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * App-wide safety net. A render error anywhere below used to blank the whole
 * dashboard (white screen) and force a manual reload. Now it's caught here and
 * shown as a recoverable message with a one-click reload.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep a console trail for debugging; never re-throw (that white-screens).
    console.error('Dashboard render error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-card">
            <h2>Something went wrong</h2>
            <p>
              This screen hit an unexpected error. Your chats are safe — reload to
              pick up where you left off.
            </p>
            <div className="error-boundary-actions">
              <button className="btn btn-primary" onClick={() => window.location.reload()}>
                Reload
              </button>
              <button className="btn btn-ghost" onClick={() => this.setState({ error: null })}>
                Try again
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
