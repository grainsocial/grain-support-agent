import type { ReactNode } from "react"
import { ExternalLinkIcon } from "lucide-react"
import type { Account, ItemSummary } from "@workspace/types"

/**
 * A link that opens in a new tab.
 *
 * Inside a queue card, which is itself a link, a nested anchor is not allowed,
 * so there it opens from a click instead.
 */
export function OutLink({ href, inCard = false, children }: { href: string; inCard?: boolean; children: ReactNode }) {
  const className = "hover:underline inline-flex min-w-0 items-center gap-1.5"
  if (inCard) {
    const open = (e: React.SyntheticEvent) => {
      e.preventDefault()
      e.stopPropagation()
      window.open(href, "_blank", "noopener,noreferrer")
    }
    return (
      <span role="link" tabIndex={0} className={className} onClick={open} onKeyDown={(e) => e.key === "Enter" && open(e)}>
        {children}
      </span>
    )
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  )
}

/** An account on grain, linked to its profile there. */
export function AccountLink({ account, inCard = false }: { account: Account; inCard?: boolean }) {
  return (
    <OutLink href={account.url} inCard={inCard}>
      <span className="text-foreground font-medium">{account.handle ? `@${account.handle}` : account.did}</span>
      {account.displayName && <span className="text-muted-foreground">{account.displayName}</span>}
      <ExternalLinkIcon className="text-muted-foreground size-3" />
    </OutLink>
  )
}

const IMAGE = /^Image: (https:\/\/cdn\.bsky\.app\/img\/\S+)$/

/**
 * A report's text with its "Subject:" line linked to the subject on grain.social
 * and a photo's "Image:" line linked to the image. Those two lines are written
 * by the poller, never by the reporter, so only their exact shapes are linked.
 */
export function ReportText({ item, inCard = false, className }: { item: ItemSummary; inCard?: boolean; className?: string }) {
  if (item.source === "bluesky" || !item.subjectLink) return <p className={className}>{item.text}</p>
  const link = item.subjectLink
  const lines = item.text.split("\n")
  const subjectLine = lines.findIndex((line) => line.startsWith("Subject: "))
  return (
    <p className={className}>
      {lines.map((line, i) => {
        const image = item.source === "classifier" ? line.match(IMAGE) : null
        let content: ReactNode = line
        if (i === subjectLine) {
          content = (
            <>
              Subject:{" "}
              <OutLink href={link.url} inCard={inCard}>
                {link.label}
                <ExternalLinkIcon className="text-muted-foreground size-3" />
              </OutLink>
            </>
          )
        } else if (image) {
          content = (
            <>
              Image:{" "}
              <OutLink href={image[1]} inCard={inCard}>
                open the image
                <ExternalLinkIcon className="text-muted-foreground size-3" />
              </OutLink>
            </>
          )
        }
        return (
          <span key={i}>
            {i > 0 && "\n"}
            {content}
          </span>
        )
      })}
    </p>
  )
}
