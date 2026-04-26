// Step 4 starter template — verbatim per resume-bot-design.md §13.5.
// Rendered alongside resume_body.typ produced by `pandoc --to=typst`.

#set page(
  paper: "us-letter",
  margin: (x: 0.6in, y: 0.55in),
)
#set text(font: "Inter", size: 10pt, hyphenate: false)
#set par(leading: 0.55em, justify: false)

#show heading.where(level: 1): it => [
  #set text(size: 18pt, weight: "bold")
  #it.body
  #v(-0.3em)
  #line(length: 100%, stroke: 0.5pt)
]

#show heading.where(level: 2): it => [
  #set text(size: 11pt, weight: "bold")
  #upper(it.body)
  #v(-0.5em)
  #line(length: 100%, stroke: 0.3pt)
]

#show link: underline

#include "resume_body.typ"
