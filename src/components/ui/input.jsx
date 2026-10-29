import * as React from "react"
import { cn } from "@/lib/utils"

// A number box takes digits (and one "." where cents are allowed) only: the
// browser would otherwise accept e, E, + and - ("1e9", "-5").
const NOT_IN_A_NUMBER = new Set(["e", "E", "+", "-"])

/** True when a number box's new text breaks its max or its step (input limits). */
function refusedNumber(text, { max, step }) {
  if (text === "") return false
  if (/[eE+-]/.test(text)) return true
  if (String(step) === "1" && text.includes(".")) return true
  const n = Number(text)
  if (!Number.isFinite(n)) return true
  return max !== undefined && max !== null && max !== "" && n > Number(max)
}

function Input({
  className,
  type,
  onChange,
  onKeyDown,
  ...props
}) {
  const isNumber = type === "number"
  // The last accepted text, put back when a change is refused.
  const accepted = React.useRef(String(props.value ?? props.defaultValue ?? ""))
  React.useEffect(() => {
    if (props.value !== undefined) accepted.current = String(props.value ?? "")
  }, [props.value])

  const handleKeyDown = isNumber
    ? (event) => {
      if (NOT_IN_A_NUMBER.has(event.key) || (event.key === "." && String(props.step) === "1")) event.preventDefault()
      onKeyDown?.(event)
    }
    : onKeyDown

  const handleChange = isNumber
    ? (event) => {
      if (refusedNumber(event.target.value, props)) {
        event.target.value = accepted.current
        return
      }
      accepted.current = event.target.value
      onChange?.(event)
    }
    : onChange

  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      onKeyDown={handleKeyDown}
      onChange={handleChange}
      {...props}
    />
  )
}

export { Input }
