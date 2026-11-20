"use client";

// The strip down the left edge of the window that switches between the app's
// views, the way VS Code's activity bar does: the editor, where the screenshots
// are made, Capture, where they are taken from the app running in a simulator
// or emulator, Growth, where their numbers come back, and Website, where the
// app's own site is made from them.
//
// A new view is one entry in ACTIVITIES and one branch where the layout draws
// the views (OpenScreenshotGeneratorLayout.tsx, `activity`). The editor stays
// mounted under every other view, so its canvas, selection and undo are as
// they were when it comes back.
//
// Below the views go places that open over whatever is on screen (Discover),
// and at the bottom the account and the app's own settings, where VS Code
// keeps Accounts and Manage. Those are `actions`: buttons with no view. A view
// can also sit under the actions (`belowActions`): Website, the app's own
// site, sits under Discover.

import React from 'react';
import {
  ArrowLeftIcon,
  CameraIcon,
  GlobeIcon,
  MoreHorizontalIcon,
  PenToolIcon,
  TrendingUpIcon,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export type ActivityId = 'editor' | 'capture' | 'growth' | 'website';

export interface Activity {
  id: ActivityId;
  /** The tooltip and the accessible name. Tests find the buttons by it. */
  label: string;
  /** Shorter label shown inside the More tools menu. */
  menuLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Grouped under the More tools menu instead of top-level on the bar. */
  secondary?: boolean;
}

export const ACTIVITIES: Activity[] = [
  { id: 'editor', label: 'Editor', icon: PenToolIcon },
  { id: 'capture', label: 'Capture: screenshots of your app', icon: CameraIcon },
  {
    id: 'growth',
    label: 'Growth: downloads, reviews and your store page',
    menuLabel: 'Growth',
    icon: TrendingUpIcon,
    secondary: true,
  },
  {
    id: 'website',
    label: "Website: your app's home, support and privacy pages",
    menuLabel: 'Website',
    icon: GlobeIcon,
    secondary: true,
  },
];

/** A button on the bar that opens something rather than switching the view. */
export interface ActivityAction {
  id: string;
  /** The accessible name. Tests find the buttons by it. */
  label: string;
  /** The tooltip, when it says more than the name. */
  title?: string;
  /** An icon, or the account's picture. */
  icon: React.ReactNode;
  onClick: () => void;
}

const BUTTON =
  'relative flex h-11 w-11 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring';
const IDLE = 'text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground';

function ViewButton({ activity, selected, count, onSelect }: { activity: Activity; selected: boolean; count: number; onSelect: (id: ActivityId) => void }) {
  const Icon = activity.icon;
  return (
    <button
      type="button"
      title={activity.label}
      aria-label={activity.label}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onSelect(activity.id)}
      className={cn(BUTTON, selected ? 'text-sidebar-foreground' : IDLE)}
    >
      {/* The mark beside the view on screen, as VS Code draws it. */}
      {selected && <span aria-hidden className="absolute -left-0.5 top-2 bottom-2 w-0.5 rounded-full bg-primary" />}
      <Icon className="h-5 w-5" />
      {count > 0 && (
        <span
          aria-hidden
          data-testid={`${activity.id}-badge`}
          className="absolute bottom-1 right-0.5 min-w-[1.1rem] rounded-full bg-amber-500 px-1 text-center text-[10px] font-semibold leading-[1.1rem] text-white"
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );
}

function ActionButton({ action }: { action: ActivityAction }) {
  return (
    <button type="button" title={action.title ?? action.label} aria-label={action.label} onClick={action.onClick} className={cn(BUTTON, IDLE)}>
      {action.icon}
    </button>
  );
}

export function ActivityBar({
  active,
  onSelect,
  badges = {},
  actions = [],
  bottomActions = [],
  className,
}: {
  active: ActivityId;
  onSelect: (id: ActivityId) => void;
  /** A count to show on a view's button, such as Growth's new insights. */
  badges?: Partial<Record<ActivityId, number>>;
  /** Secondary actions (such as Discover), grouped under More tools. */
  actions?: ActivityAction[];
  /** At the foot of the bar. */
  bottomActions?: ActivityAction[];
  className?: string;
}) {
  const primaryActivities = ACTIVITIES.filter((activity) => !activity.secondary);
  const secondaryActivities = ACTIVITIES.filter((activity) => activity.secondary);
  const secondarySelected = secondaryActivities.some((activity) => activity.id === active);
  const secondaryBadgeCount = secondaryActivities.reduce(
    (sum, activity) => sum + (badges[activity.id] ?? 0),
    0
  );

  return (
    <nav
      aria-label="Views"
      className={cn(
        'z-20 w-12 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2 text-sidebar-foreground',
        // The dev server draws Next's own badge over the bottom left corner,
        // where About would sit under it. Release builds have no badge.
        process.env.NODE_ENV === 'development' && 'pb-16',
        className
      )}
      data-testid="activity-bar"
    >
      {primaryActivities.map((activity) => (
        <ViewButton key={activity.id} activity={activity} selected={activity.id === active} count={badges[activity.id] ?? 0} onSelect={onSelect} />
      ))}

      {(secondaryActivities.length > 0 || actions.length > 0) && (
        <>
          <span aria-hidden className="my-1 h-px w-6 bg-sidebar-border" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="More tools"
                aria-label="More tools"
                aria-current={secondarySelected ? 'page' : undefined}
                className={cn(BUTTON, secondarySelected ? 'text-sidebar-foreground' : IDLE)}
              >
                {secondarySelected && (
                  <span aria-hidden className="absolute -left-0.5 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
                )}
                <MoreHorizontalIcon className="h-5 w-5" />
                {secondaryBadgeCount > 0 && (
                  <span
                    aria-hidden
                    data-testid={(badges.growth ?? 0) > 0 ? 'growth-badge' : 'more-tools-badge'}
                    className="absolute bottom-1 right-0.5 min-w-[1.1rem] rounded-full bg-amber-500 px-1 text-center text-[10px] font-semibold leading-[1.1rem] text-white"
                  >
                    {secondaryBadgeCount > 9 ? '9+' : secondaryBadgeCount}
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-60">
              {secondaryActivities.map((activity) => {
                const Icon = activity.icon;
                const count = badges[activity.id] ?? 0;
                const isSelected = active === activity.id;
                return (
                  <DropdownMenuItem
                    key={activity.id}
                    aria-label={activity.label}
                    onSelect={() => onSelect(activity.id)}
                    className={cn('gap-2.5 py-2', isSelected && 'bg-accent/50 font-medium')}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{activity.menuLabel ?? activity.label}</span>
                    {count > 0 && (
                      <span
                        data-testid={`${activity.id}-menu-badge`}
                        className="min-w-[1.1rem] rounded-full bg-amber-500 px-1.5 text-center text-[10px] font-semibold leading-[1.1rem] text-white"
                      >
                        {count > 9 ? '9+' : count}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
              {actions.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  {actions.map((action) => (
                    <DropdownMenuItem
                      key={action.id}
                      aria-label={action.label}
                      onSelect={action.onClick}
                      className="gap-2.5 py-2"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">
                        {action.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{action.label}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {active !== 'editor' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onSelect('editor')} className="gap-2.5 py-2">
                    <ArrowLeftIcon className="h-4 w-4 shrink-0" />
                    <span>Back to the editor</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {bottomActions.length > 0 && (
        <div className="mt-auto flex flex-col items-center gap-1">
          {bottomActions.map((action) => (
            <ActionButton key={action.id} action={action} />
          ))}
        </div>
      )}
    </nav>
  );
}
