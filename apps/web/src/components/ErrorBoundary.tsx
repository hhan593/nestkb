import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('UI crash:', error); }
  render() {
    if (this.state.error) {
      return <pre style={{ padding: 40, color: '#b42318', whiteSpace: 'pre-wrap' }}>{String(this.state.error.stack || this.state.error)}</pre>;
    }
    return this.props.children;
  }
}
