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
      const isChunkError = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
        String(this.state.error),
      );
      if (isChunkError) {
        // 发版后旧 hash chunk 404：给一键重载而不是裸堆栈（#56）
        return (
          <div style={{ padding: 60, textAlign: 'center', fontFamily: 'inherit' }}>
            <h2 style={{ marginBottom: 8 }}>页面版本已更新</h2>
            <p style={{ color: '#55554f' }}>请刷新页面加载最新版本</p>
            <button
              onClick={() => window.location.reload()}
              style={{ marginTop: 16, padding: '8px 24px', background: '#b42318', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 14 }}
            >
              刷新页面
            </button>
          </div>
        );
      }
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
