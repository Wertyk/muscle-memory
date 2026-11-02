/** Keep narrative text readable while giving record IDs and money tabular figures. */
export function DataText({ text }: { text: string }) {
  return <>{text.split(/(\b(?:req|ord)_[A-Za-z0-9_-]+\b|[-−]?[$€£]\d[\d,.]*)/g).map((part, index) =>
    index % 2 ? <span className="kiln-data" key={index}>{part}</span> : part,
  )}</>;
}
