'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { MessageSquare, Reply, Trash2, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommentAuthor {
  id: string;
  name: string | null;
}

interface CommentData {
  id: string;
  content: string;
  authorId: string;
  author: CommentAuthor;
  parentId: string | null;
  canDelete: boolean;
  replies: CommentData[];
  createdAt: string;
}

interface CommentsResponse {
  comments: CommentData[];
  total: number;
  page: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// CommentForm
// ---------------------------------------------------------------------------

interface CommentFormProps {
  onSubmit: (content: string) => void;
  isSubmitting: boolean;
  placeholder?: string;
  onCancel?: () => void;
}

function CommentForm({
  onSubmit,
  isSubmitting,
  placeholder = 'Write a comment...',
  onCancel,
}: CommentFormProps) {
  const [content, setContent] = useState('');

  const handleSubmit = () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setContent('');
  };

  return (
    <div className="space-y-2">
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder}
        maxLength={1000}
        rows={3}
        disabled={isSubmitting}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {content.length}/1000
        </span>
        <div className="flex gap-2">
          {onCancel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!content.trim() || isSubmitting}
          >
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Post
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommentItem
// ---------------------------------------------------------------------------

interface CommentItemProps {
  comment: CommentData;
  isAuthenticated: boolean;
  onReply: (parentId: string, content: string) => void;
  onDelete: (commentId: string) => void;
  isSubmitting: boolean;
}

function CommentItem({
  comment,
  isAuthenticated,
  onReply,
  onDelete,
  isSubmitting,
}: CommentItemProps) {
  const [showReplyForm, setShowReplyForm] = useState(false);

  const isRoot = comment.parentId === null;

  return (
    <div className="space-y-3">
      {/* Comment body */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">
            {comment.author.name || 'Anonymous'}
          </span>
          <span className="text-muted-foreground">
            {formatTimeAgo(new Date(comment.createdAt))}
          </span>
        </div>

        <p className="text-sm whitespace-pre-wrap">{comment.content}</p>

        <div className="flex items-center gap-2">
          {isRoot && isAuthenticated && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setShowReplyForm(!showReplyForm)}
            >
              <Reply className="mr-1 h-3 w-3" />
              Reply
            </Button>
          )}
          {comment.canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(comment.id)}
              disabled={isSubmitting}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* Inline reply form */}
      {showReplyForm && (
        <div className="ml-4">
          <CommentForm
            placeholder="Write a reply..."
            isSubmitting={isSubmitting}
            onSubmit={(content) => {
              onReply(comment.id, content);
              setShowReplyForm(false);
            }}
            onCancel={() => setShowReplyForm(false)}
          />
        </div>
      )}

      {/* Nested replies */}
      {comment.replies && comment.replies.length > 0 && (
        <div className="ml-4 border-l-2 border-muted pl-4 space-y-3">
          {comment.replies.map((reply) => (
            <CommentItem
              key={reply.id}
              comment={reply}
              isAuthenticated={isAuthenticated}
              onReply={onReply}
              onDelete={onDelete}
              isSubmitting={isSubmitting}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommentSection (main export)
// ---------------------------------------------------------------------------

interface CommentSectionProps {
  targetType: 'PUBLICATION' | 'PROFILE';
  targetId: string;
}

export function CommentSection({ targetType, targetId }: CommentSectionProps) {
  const { data: session } = useSession();
  const isAuthenticated = !!session?.user;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const limit = 20;

  const queryKey = ['comments', targetType, targetId, page];

  // ---- Fetch comments ----
  const { data, isLoading } = useQuery<CommentsResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        targetType,
        targetId,
        page: String(page),
        limit: String(limit),
      });
      const res = await fetch(`/api/comments?${params}`);
      if (!res.ok) {
        throw new Error('Failed to load comments');
      }
      const json = await res.json();
      return json.data as CommentsResponse;
    },
  });

  // ---- Create comment / reply ----
  const createMutation = useMutation({
    mutationFn: async ({
      content,
      parentId,
    }: {
      content: string;
      parentId?: string;
    }) => {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType, targetId, content, parentId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Failed to post comment');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', targetType, targetId] });
    },
    onError: (err: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: err.message,
      });
    },
  });

  // ---- Delete comment ----
  const deleteMutation = useMutation({
    mutationFn: async (commentId: string) => {
      const res = await fetch(`/api/comments/${commentId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Failed to delete comment');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', targetType, targetId] });
    },
    onError: (err: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: err.message,
      });
    },
  });

  const isSubmitting = createMutation.isPending || deleteMutation.isPending;

  const handleCreate = (content: string) => {
    createMutation.mutate({ content });
  };

  const handleReply = (parentId: string, content: string) => {
    createMutation.mutate({ content, parentId });
  };

  const handleDelete = (commentId: string) => {
    deleteMutation.mutate(commentId);
  };

  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  return (
    <Card>
      <CardContent className="pt-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          <h3 className="font-semibold">
            Comments{data && data.total > 0 ? ` (${data.total})` : ''}
          </h3>
        </div>

        {/* Comment form or login prompt */}
        {isAuthenticated ? (
          <CommentForm
            onSubmit={handleCreate}
            isSubmitting={isSubmitting}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            <Link href="/login" className="underline hover:text-foreground">
              Log in
            </Link>{' '}
            to leave a comment.
          </p>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Comments list */}
        {data && data.comments.length > 0 && (
          <div className="space-y-4">
            {data.comments.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                isAuthenticated={isAuthenticated}
                onReply={handleReply}
                onDelete={handleDelete}
                isSubmitting={isSubmitting}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {data && data.comments.length === 0 && !isLoading && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No comments yet. Be the first to comment!
          </p>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
