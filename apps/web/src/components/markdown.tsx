import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

// Agent text, rendered. The agents read text written by strangers, so raw
// HTML is dropped and images are never rendered: an image URL in a reply
// would be fetched the moment the page opened, which is how a prompt
// injection would carry data out. Links stay, since nothing follows a link
// until it is clicked; react-markdown already refuses javascript: URLs.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
