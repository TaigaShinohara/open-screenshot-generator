"use client";

import React from 'react';
import {
  CheckCircle2Icon,
  EyeIcon,
  GlobeIcon,
  LanguagesIcon,
  UploadCloudIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { localeName } from '@/lib/i18n/locales';

export interface ExportSummaryData {
  fileCount: number;
  languages: string[];
  formatLabels: string[];
  destination: string | null;
  isDesktop: boolean;
}

interface ExportSummaryCardProps {
  summary: ExportSummaryData | null;
  onDismiss: () => void;
  onPublishToStore?: () => void;
  onPreviewStore?: () => void;
  onManageLanguages?: () => void;
  onOpenWebsite?: () => void;
}

/**
 * Non-modal completion summary shown after a clean screenshot export.
 *
 * Kept non-modal on purpose so it never blocks the canvas or hides toolbar
 * controls behind a backdrop, while still giving the user a clear release
 * summary and one-click next steps into store upload, preview, languages,
 * or their app website.
 */
export function ExportSummaryCard({
  summary,
  onDismiss,
  onPublishToStore,
  onPreviewStore,
  onManageLanguages,
  onOpenWebsite,
}: ExportSummaryCardProps) {
  if (!summary) return null;

  const languageText =
    summary.languages.length > 0
      ? summary.languages.map((code) => localeName(code)).join(', ')
      : null;

  return (
    <section
      role="status"
      aria-live="polite"
      data-testid="export-summary-card"
      className="fixed bottom-20 right-4 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-emerald-500/40 bg-card/95 p-4 shadow-xl backdrop-blur"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold leading-snug">Ready for store release</h3>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss export summary"
              title="Dismiss"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {summary.fileCount} PNG {summary.fileCount === 1 ? 'file' : 'files'} exported
            {summary.destination ? ` to ${summary.destination}` : ''}.
          </p>
          {(summary.formatLabels.length > 0 || languageText) && (
            <div className="space-y-0.5 pt-0.5 text-xs text-muted-foreground">
              {summary.formatLabels.length > 0 && (
                <p className="truncate">Sizes: {summary.formatLabels.join(', ')}</p>
              )}
              {languageText && <p className="truncate">Languages: {languageText}</p>}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        {onPublishToStore && (
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              onDismiss();
              onPublishToStore();
            }}
          >
            <UploadCloudIcon className="mr-1.5 h-3.5 w-3.5" />
            {summary.isDesktop ? 'Upload to the store' : 'Store upload'}
          </Button>
        )}
        {onPreviewStore && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => {
              onDismiss();
              onPreviewStore();
            }}
          >
            <EyeIcon className="mr-1.5 h-3.5 w-3.5" />
            Store preview
          </Button>
        )}
        {onManageLanguages && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => {
              onDismiss();
              onManageLanguages();
            }}
          >
            <LanguagesIcon className="mr-1.5 h-3.5 w-3.5" />
            Languages
          </Button>
        )}
        {onOpenWebsite && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => {
              onDismiss();
              onOpenWebsite();
            }}
          >
            <GlobeIcon className="mr-1.5 h-3.5 w-3.5" />
            App website
          </Button>
        )}
      </div>
    </section>
  );
}
