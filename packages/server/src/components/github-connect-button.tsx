'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Github, Check, X, Loader2 } from 'lucide-react';

interface GitHubStatus {
  isConnected: boolean;
  username: string | null;
  avatarUrl?: string;
}

export function GitHubConnectButton() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    checkStatus();
  }, []);

  // Re-check status after GitHub OAuth callback
  useEffect(() => {
    const githubParam = searchParams.get('github');
    if (githubParam === 'connected') {
      // Token was saved in /api/github/callback, refresh status
      checkStatus();
    }
  }, [searchParams]);

  const checkStatus = async () => {
    try {
      const response = await fetch('/api/github/connect');
      const data = await response.json();
      if (data.success) {
        setStatus(data.data);
      } else {
        // If unauthorized or error, show as not connected
        setStatus({ isConnected: false, username: null });
      }
    } catch (error) {
      console.error('Failed to check GitHub status:', error);
      setStatus({ isConnected: false, username: null });
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = () => {
    setConnecting(true);
    // Custom OAuth flow — does NOT replace the current session
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.href = `/api/github/oauth?returnTo=${encodeURIComponent(returnTo)}`;
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const response = await fetch('/api/github/connect', {
        method: 'DELETE',
      });
      if (response.ok) {
        setStatus({ isConnected: false, username: null });
      }
    } catch (error) {
      console.error('Failed to disconnect GitHub:', error);
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm text-muted-foreground">Checking connection...</span>
      </div>
    );
  }

  if (status?.isConnected) {
    return (
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Github className="h-5 w-5" />
            <span className="font-medium">GitHub</span>
          </div>
          <Badge variant="secondary" className="gap-1">
            <Check className="h-3 w-3" />
            Connected
          </Badge>
          {status.username && (
            <span className="text-sm text-muted-foreground">
              @{status.username}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleDisconnect}
          disabled={disconnecting}
        >
          {disconnecting ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <X className="h-4 w-4 mr-2" />
          )}
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Github className="h-5 w-5" />
          <span className="font-medium">GitHub</span>
        </div>
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          Not connected
        </Badge>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={handleConnect}
        disabled={connecting}
      >
        {connecting ? (
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
        ) : (
          <Github className="h-4 w-4 mr-2" />
        )}
        Connect GitHub
      </Button>
    </div>
  );
}
