import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  page?: string;
}

interface ErrorBoundaryState {
  error?: Error;
}

function safeErrorMessage(error?: Error): string {
  return error?.message?.trim() || "页面渲染发生未知错误";
}

export class PageErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("RENDERER_PAGE_ERROR", { page: this.props.page, error, componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const page = this.props.page || "当前页面";
    return <section className="renderer-error-page renderer-page-error"><span className="page-kicker">PAGE RECOVERY</span><h2>{page}暂时无法显示</h2><p>页面数据可能来自旧版本缓存，但应用其他功能仍可继续使用。</p><p className="renderer-error-code">错误代码：RENDERER_PAGE_ERROR</p><div className="detail-actions"><button className="dark-pill" onClick={() => this.setState({ error: undefined })}>重试页面</button><button className="outline-pill" onClick={() => window.location.reload()}>重新加载应用</button></div>{import.meta.env.DEV && <pre className="renderer-error-detail">{safeErrorMessage(this.state.error)}</pre>}</section>;
  }
}

export class RootErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("RENDERER_RUNTIME_ERROR", { error, componentStack: info.componentStack });
  }

  copyError = async (): Promise<void> => {
    const text = `RENDERER_RUNTIME_ERROR\n${safeErrorMessage(this.state.error)}`;
    try { await navigator.clipboard?.writeText(text); } catch { /* clipboard permission is optional */ }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <main className="renderer-error-page renderer-root-error"><span className="page-kicker">有招</span><h1>有招 页面发生异常</h1><p>应用已阻止错误继续扩散，原始资料不会因此丢失。</p><p className="renderer-error-code">错误代码：RENDERER_RUNTIME_ERROR</p>{import.meta.env.DEV && <pre className="renderer-error-detail">{safeErrorMessage(this.state.error)}</pre>}<div className="detail-actions"><button className="dark-pill" onClick={() => window.location.reload()}>重新加载</button><button className="outline-pill" onClick={() => void this.copyError()}>复制错误信息</button></div></main>;
  }
}

