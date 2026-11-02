import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; info: string }> {
  state = { error: null as Error | null, info: '' };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('UI crash:', error);
    this.setState({ info: info.componentStack ?? '' });
  }
  render() {
    if (this.state.error) {
      return (
        <pre style={{ padding: 40, color: '#b42318', whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {String(this.state.error.stack || this.state.error)}
          {'\n\n── 组件栈 ──\n'}
          {this.state.info}
        </pre>
      );
    }
    return this.props.children;
  }
}
