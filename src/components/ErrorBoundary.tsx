import { Component, ErrorInfo, ReactNode } from 'react';

type Props = {
  children: ReactNode;
  title?: string;
};

type State = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Error details are deliberately not logged; form input can contain sensitive data.
  }

  private retry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <section className="panel error-fallback" role="alert">
          <h2>{this.props.title ?? 'This screen could not be displayed'}</h2>
          <p>Something went wrong while displaying this screen. Your saved local data has not been erased.</p>
          <button type="button" className="primary-btn" onClick={this.retry}>Try again</button>
        </section>
      );
    }
    return this.props.children;
  }
}
