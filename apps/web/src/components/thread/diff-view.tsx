import { cn } from "@workspace/ui/lib/utils"

/** A unified diff, line by line, coloured by what each line does. */
export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="bg-muted/50 mt-2 overflow-x-auto rounded-lg border py-2 font-mono text-xs leading-relaxed">
      {diff.split("\n").map((line, i) => (
        <div
          key={i}
          className={cn(
            "px-3",
            line.startsWith("diff --git") && "font-semibold",
            line.startsWith("@@") && "text-primary",
            line.startsWith("+") && !line.startsWith("+++") && "bg-emerald-500/15",
            line.startsWith("-") && !line.startsWith("---") && "bg-red-500/15"
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  )
}
