import { AlertTriangleIcon, InboxIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A friendly "nothing here yet" in place of a blank panel. */
export function EmptyState({ icon: Icon = InboxIcon, title, description, action, className }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-4 py-10 text-center", className)}>
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** A load that failed, with a retry when one makes sense. */
export function ErrorState({ message, onRetry, className }) {
  return (
    <EmptyState
      icon={AlertTriangleIcon}
      className={className}
      title="Something went wrong"
      description={message || "This could not be loaded. Check your connection and try again."}
      action={onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button> : null}
    />
  );
}
