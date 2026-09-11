import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';

/**
 * Catches a render error and offers a way back.
 *
 * Boundaries are placed per region — shell, sidebar, transcript — rather than
 * once at the root, because the blast radius should match the failure. A
 * conversation whose content throws while rendering should cost the reader that
 * pane, not the navigation they need to get away from it.
 *
 * Still a class: `componentDidCatch` has no hook equivalent.
 */

export interface ErrorBoundaryProps {
  /** Named in the message, so it is clear *what* failed. */
  region: string;
  children: ReactNode;
  /**
   * Bumped by the parent to force a remount — used to reset the boundary when
   * the user navigates away from whatever triggered it.
   */
  resetKey?: string | null;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    // Navigating away clears the failure: the next render is of different
    // content, so holding the old error would strand the user on it.
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="boundary" role="alert">
        <h3 className="boundary__title">Something went wrong in the {this.props.region}.</h3>
        {/*
          The message is shown because this is self-hosted software: the person
          looking at it is very often the person who can fix it, and hiding the
          cause behind "an error occurred" only means a trip to the console.
        */}
        <p className="boundary__detail">{error.message}</p>
        <button type="button" className="button-primary" onClick={this.retry}>
          <RotateCcw size={15} />
          Try again
        </button>
      </div>
    );
  }
}
