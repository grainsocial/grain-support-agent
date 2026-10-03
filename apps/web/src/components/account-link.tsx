import { ExternalLinkIcon } from "lucide-react"
import type { Account } from "@workspace/types"

/** "@handle", or the DID when the appview knows no handle for it. */
function name(account: Account) {
  return account.handle ? `@${account.handle}` : account.did
}

/**
 * An account on grain, linked to its profile there.
 *
 * Inside a queue card, which is itself a link, a nested anchor is not allowed,
 * so there it opens the profile from a click instead.
 */
export function AccountLink({ account, inCard = false }: { account: Account; inCard?: boolean }) {
  const content = (
    <>
      <span className="text-foreground font-medium">{name(account)}</span>
      {account.displayName && <span className="text-muted-foreground">{account.displayName}</span>}
      <ExternalLinkIcon className="text-muted-foreground size-3" />
    </>
  )
  const className = "hover:underline inline-flex min-w-0 items-center gap-1.5"
  if (inCard) {
    return (
      <span
        role="link"
        tabIndex={0}
        className={className}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          window.open(account.url, "_blank", "noopener,noreferrer")
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return
          e.preventDefault()
          e.stopPropagation()
          window.open(account.url, "_blank", "noopener,noreferrer")
        }}
      >
        {content}
      </span>
    )
  }
  return (
    <a href={account.url} target="_blank" rel="noopener noreferrer" className={className}>
      {content}
    </a>
  )
}
