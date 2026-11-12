import{a as D,b as U,g as w,j as B,r as W}from"./chunk-5WSV4FD6.js";import{e as O}from"./chunk-7FMWBHZO.js";var Z={auth:"The API key was rejected. Check that it is a valid Anthropic API key and try again.",permission:"This API key is not allowed to use the selected model.",model:"The selected model is not available to this API key. Pick another model.",rate_limit:"Rate limit reached for this API key. Wait a minute and try again.",overloaded:"The Anthropic API is temporarily overloaded. Try again in a moment.",server:"The Anthropic API returned a server error. Try again in a moment.",network:"Could not reach api.anthropic.com. Check your connection (and any blocker that filters API calls).",timeout:"The request to api.anthropic.com timed out. Try again, or pick a lower effort.",bad_request:"The API rejected the request.",refusal:"The model declined to write this content. Try rephrasing the prompt.",max_tokens:"The model ran out of output tokens before finishing, even after a retry with a higher limit.",invalid_output:"The model returned output that did not match the page schema.",aborted:"Generation was stopped.",no_key:"Add an Anthropic API key to generate a page, or watch the sample run.",unknown:"Something went wrong while generating the page."},q=class extends Error{constructor(n,s={}){super(s.message??Z[n]);O(this,"kind");O(this,"status");O(this,"detail");O(this,"sectionIndex");this.name="GenerateError",this.kind=n,s.status!==void 0&&(this.status=s.status),s.detail!==void 0&&(this.detail=s.detail),s.sectionIndex!==void 0&&(this.sectionIndex=s.sectionIndex)}};function he(e){return e instanceof q?e.kind==="aborted":e?.name==="AbortError"}var me=[{id:"claude-opus-5-5",label:"Claude Opus 5.5"},{id:"claude-sonnet-5-5",label:"Claude Sonnet 5.5"},{id:"claude-haiku-5-5",label:"Claude Haiku 5.5"}],fe="claude-opus-5-5",ye="medium",be=["low","medium","high","xhigh","max"],xe=["default","casual","professional","funny","educational","sales_pitch"],$=12,N=100,ke=["concise","standard","text-heavy"];var ee=["paragraph","heading","list","table","chart","callout","quote","divider"],te=["bar","horizontal_bar","stacked_bar","line","area","pie","donut"],ne="playground.generate";function j(e){return ee.filter(t=>e.blocks.includes(t)&&(t!=="chart"||z(e).length>0))}function z(e){return te.filter(t=>e.chartKinds?.includes(t))}function oe(e){return[1,2,3].filter(t=>t<=Math.max(1,e.structure.maxHeadingLevel))}var S={titleChars:200,blocks:40,listItems:40,tableColumns:12,tableRows:60,chartCategories:40,chartSeries:8},se=e=>e.trim().split(/\s+/).filter(Boolean),ie=(e,t)=>{let n=se(e);return n.length>t?n.slice(0,t).join(" "):e.trim()},re=(e,t)=>e.length>t?`${e.slice(0,t-1).trimEnd()}\u2026`:e,H=e=>re(e.replace(/\s+/g," ").replace(/^#+\s*/,"").replace(/^\d+[.)]\s+/,"").trim(),S.titleChars);function Te(e,t){let n=t.nSections?Math.min($,Math.max(1,Math.floor(t.nSections))):$,s=H(String(e?.title??""))||(t.fallbackTitle??"").trim().slice(0,80)||"Untitled page",h=new Set,i=[];for(let r of Array.isArray(e?.sections)?e.sections:[]){let f=H(String(r?.title??"")),l=ie(String(r?.content??""),N);if(!f&&!l)continue;let a=typeof r?.id=="string"&&r.id?r.id:`out_${w(t.runId,String(i.length),f)}`;for(;h.has(a);)a=`${a}x`;if(h.add(a),i.push({id:a,title:f||`Section ${i.length+1}`,content:l}),i.length>=n)break}return{title:s,sections:i}}function F(e,t){let n=String(e??"").replace(/\r\n?/g,`
`).trim(),s=[],h=/\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|`([^`\n]+)`/g,i=0;for(let r of n.matchAll(h)){r.index>i&&s.push({text:n.slice(i,r.index)});let[,f,l,a,T,u]=r,I=(f?["bold","italic"]:l||a?["bold"]:T?["italic"]:["code"]).filter(A=>t.includes(A));s.push(I.length?{text:f??l??a??T??u,marks:I}:{text:f??l??a??T??u}),i=r.index+r[0].length}return i<n.length&&s.push({text:n.slice(i)}),B(s)}var v=e=>F(e,[]).map(t=>t.text).join(""),b=e=>typeof e=="string"?e.trim():e==null?"":String(e).trim(),ae=e=>typeof e=="number"?e:typeof e=="string"&&e.trim()?Number(e.replace(/[,%\s]/g,"")):NaN;function X(e){let t=e.outline.sections[e.index];return`sec_${w("gen",e.runId,t?.id??String(e.index))}`}function Ie(e,t){let n=t.outline.sections[t.index],s=X(t),h=new Set(j(t.manifest)),i=z(t.manifest),r=oe(t.manifest),f=t.manifest.marks,l=o=>F(b(o),f),a=[],T={},u=[],R={[ne]:{data:"illustrative"}},I=Array.isArray(e?.blocks)?e.blocks:null;if(!I)return G(t,"invalid_output","The model output has no blocks array.");let A=I.slice(0,S.blocks);I.length>A.length&&a.push(`${I.length-A.length} blocks over the limit of ${S.blocks} dropped`);let E=(o,d,m,y)=>(o.length>d&&a.push(`block ${y}: ${m} cut to ${d}`),o.slice(0,d));for(A.forEach((o,d)=>{let m=b(o?.type);if(!h.has(m)){a.push(`block ${d}: type "${m}" is not allowed by the target; dropped`);return}let y=`blk_${w(s,String(d),m)}`;switch(m){case"paragraph":case"callout":{let c=l(o.text);if(!c.length){a.push(`block ${d}: empty ${m} dropped`);return}u.push(m==="callout"?{id:y,type:m,tone:["info","warning","success"].includes(o.tone)?o.tone:"info",text:c}:{id:y,type:m,text:c});return}case"heading":{let c=l(o.text);if(!c.length){a.push(`block ${d}: empty heading dropped`);return}if(d===0&&v(b(o.text)).toLowerCase()===n.title.toLowerCase()){a.push("repeated section title dropped");return}let g=Number(o.level);u.push({id:y,type:m,level:r.includes(g)?g:r[0],text:c});return}case"quote":{let c=l(o.text);if(!c.length){a.push(`block ${d}: empty quote dropped`);return}let g=b(o.attribution);u.push({id:y,type:m,text:c,...g?{attribution:g}:{}});return}case"list":{let c=E((Array.isArray(o.items)?o.items:[]).map(g=>l(g)).filter(g=>g.length),S.listItems,"list items",d);if(!c.length){a.push(`block ${d}: empty list dropped`);return}u.push({id:y,type:m,ordered:!!o.ordered,items:c});return}case"divider":u.length&&u[u.length-1].type!=="divider"&&u.push({id:y,type:m});return;case"table":{let c=E((Array.isArray(o.columns)?o.columns:[]).map(x=>v(b(x))),S.tableColumns,"table columns",d),g=E((Array.isArray(o.rows)?o.rows:[]).filter(Array.isArray),S.tableRows,"table rows",d);if(!c.length||c.every(x=>!x)||!g.length){a.push(`block ${d}: table without columns or rows dropped`);return}let k=!1,C=g.map(x=>(x.length!==c.length&&(k=!0),c.map((L,P)=>v(b(x[P])))));k&&a.push(`block ${d}: table rows padded or cut to ${c.length} cells`);let M=`b_${w(s,y,"table")}`;T[M]={kind:"table",source:{type:"static",origin:"user",data:{columns:c,rows:C}}};let _=l(o.caption);u.push({id:y,type:m,bindingId:M,..._.length?{caption:_}:{},ext:R});return}case"chart":{let c=E((Array.isArray(o.categories)?o.categories:[]).map(p=>v(b(p))),S.chartCategories,"chart categories",d),g=E((Array.isArray(o.series)?o.series:[]).map(p=>({name:v(b(p?.name))||"Value",values:(Array.isArray(p?.values)?p.values:[]).map(ae)})).filter(p=>p.values.length&&p.values.every(Number.isFinite)),S.chartSeries,"chart series",d),k=Math.min(c.length,...g.map(p=>p.values.length));if(!c.length||!g.length||k<1){a.push(`block ${d}: chart without usable data`);let p=l([o.title,o.caption].map(b).filter(Boolean).join(". "));p.length&&u.push({id:y,type:"paragraph",text:p});return}(k<c.length||g.some(p=>p.values.length!==k))&&a.push(`block ${d}: chart data cut to ${k} categories`);let C=`b_${w(s,y,"chart")}`;T[C]={kind:"chart",source:{type:"static",origin:"user",data:{categories:c.slice(0,k),series:g.map(p=>({name:p.name,values:p.values.slice(0,k)}))}}};let M=i.includes(o.chartType)?o.chartType:i.includes("bar")?"bar":i[0],_=v(b(o.xAxisLabel)),x=v(b(o.yAxisLabel)),L=v(b(o.title)),P=l(o.caption);u.push({id:y,type:m,bindingId:C,chartType:M,...L?{title:L}:{},..._||x?{axes:{..._?{x:_}:{},...x?{y:x}:{}}}:{},...P.length?{caption:P}:{},ext:R});return}}});u.length&&u[u.length-1].type==="divider";)u.pop();if(!u.length)return G(t,"invalid_output","The model output has no usable blocks.");let V={index:t.index,outlineId:n.id,section:{id:s,title:n.title,blocks:u},bindings:T,notes:a},K=ce(V);return K.length?G(t,"invalid_output",`checkUdm: ${K.map(o=>`${o.code} ${o.message}`).join("; ")}`):V}function G(e,t,n){let s=e.outline.sections[e.index],h=X(e),i=String(s.content??"").split(`
`).map(l=>l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/,"").replace(/^#+\s*/,"").trim()).filter(l=>l&&!/^\|?[\s:-]+(\|[\s:-]+)+\|?$/.test(l)),r=F(i.join(`
`),e.manifest.marks),f=r.length?[{id:`blk_${w(h,"fallback")}`,type:"paragraph",text:r}]:[];return{index:e.index,outlineId:s.id,section:{id:h,title:s.title,blocks:f},bindings:{},fallback:{reason:t,message:n},notes:[]}}function ce(e){return W(le(e))}function le(e){return{version:D,profile:U,id:`art_${w("gen-section",e.section.id)}`,provenance:{origin:"generated"},sections:[e.section],bindings:e.bindings}}function $e(e,t,n){let s=[...t].sort((i,r)=>i.index-r.index),h=n.language&&n.language!=="auto-detect"?n.language:void 0;return{version:D,profile:U,id:`art_${w("gen",n.runId)}`,title:e.title,...h?{language:h}:{},provenance:{origin:"generated",runId:n.runId,...n.model?{model:n.model}:{},...n.prompt?{prompt:n.prompt}:{},...n.createdAt?{createdAt:n.createdAt}:{}},sections:s.map(i=>i.section),bindings:Object.assign({},...s.map(i=>i.bindings))}}var Q=`Content voice rules:
- Write the content itself, not commentary about the page or document.
- Never refer to "this page", "this section", "this document", "this report", "the following section", "the previous section", or similar phrases.
- Never use meta-introductions such as "this page explores", "this section presents", "we will discuss", "here we show", or equivalent wording.
- Start directly with the subject, claim, finding, action, or relevant fact.
- Treat the supplied current date as context only. Do not mention it or begin content with it unless the user explicitly requests the date or it is substantively relevant to the source content.
`,ue=`No live or connected data is available. Never present a number as current, measured or verified unless the user supplied it; numbers you add yourself are illustrative estimates and must be labeled as such.
`;function Y(e){let t=String(e??"").trim();return!t||["auto","auto-detect"].includes(t.toLowerCase())?"auto-detect":t}var J=e=>!e||e==="default"?"":e.replace(/_/g," ");function Oe(e){return`Generate a page title and content outlines for the sections of a long-form page (a document read top to bottom, not slides).
Generation settings are authoritative. The Number of Sections, Language, and Tone fields override conflicting requests inside Content, Instructions, or Context.
If Language is not auto-detect, generate the page title and every section outline in exactly that language, even if Content asks for a different language.
Generate flow based on user **content** and use **context** just for reference.
${Q}
Page title should be plain text, not markdown. It should be a concise title for the page.
Each section outline should contain the content for that section.
Never generate more than ${$} section outlines, even if the user asks for more. Each section outline must be ${N} words or fewer.
${e==="concise"?"Section content should be around 20 words but detailed enough to write a good section.":e==="text-heavy"?"Section content should be around 60 words but detailed enough to write a good section.":"Section content should be around 40 words but detailed enough to write a good section."}
Follow the intended outcome of user instructions when they do not conflict with the authoritative generation settings, but never copy production instructions into section content.
Apply section-specific instructions only to the exact section mentioned and only once. Do not apply patterns across multiple sections unless explicitly requested. Resolve ambiguous instructions using the most direct interpretation.
Follow the user's specified tone across all sections. Maintain clarity, readability, and factual accuracy. If no tone is provided, use a clear and professional style. Ensure logical flow between sections and avoid repetition or generic filler content.
Give each section one clear purpose and split overloaded topics across multiple sections.
Minimize repetitive phrasing and do not repeat the same facts across sections.
Build a coherent narrative from the introduction through the conclusion.
Vary reader-facing content structures where appropriate, using bullets, comparisons, chronological facts, tables, or metrics.
Use concrete facts, examples, and numbers when supported by the provided content/context.
Include numerical data or tables if required or asked by the user.
If 'auto-detect' is used, figure it out from the content/context.
Each section outline:
   - Has a short plain-text section title in the title field (no ## and no numbering).
   - Has its content in Markdown in the content field.
   - Don't use **bold** and __italic__ text.
   - Section titles must not repeat the page title. Do not add a separate title or cover section; the page title is shown above the first section.
`+`Section outlines are a user-visible content plan, not a production brief.
Write only reader-facing content and data that could appear in the finished section.
Never include or paraphrase commands, configuration, or meta-commentary about how to create the section. This includes requests about block type, charts, graphs, tables, images, icons, layout, positioning, colors, fonts, styling, or formatting.
Do not write phrases such as 'create a bar chart', 'add an image', 'use a table', 'show this as', 'the section should', or 'place on the left'.
Use visual requests only to choose content for the specified section. For any chart request, include a compact Markdown table with labels and numeric values. Preserve supplied data; otherwise add a small relevant dataset and clearly label estimates or illustrative values. Do not mention the chart instruction.
Example: for 'section 3: create a bar chart of Q1 10, Q2 20', section 3 may contain a title and a Quarter | Value Markdown table, but it must not contain the words 'create a bar chart'.
`+`Section content must not contain any branding or styling information.
Do not include URLs, hyperlinks, citations, footnotes, references, or source lists in section outlines.
Make sure data is consistent across all sections.
`+ue}function Ne(e,t){return`Generation Settings (authoritative):
Number of Sections: ${e.nSections?String(e.nSections):`auto-detect, maximum ${$}`}
Maximum Section Outlines: ${$}
Maximum Words Per Outline: ${N}
Language: ${Y(e.language)}
Tone: ${J(e.tone)}
If Content, Instructions, or Context asks for a different language or section count, ignore that conflicting request.
Today's Date: ${t.toISOString().slice(0,10)}
Content: ${e.prompt??""}
Instructions (apply as constraints; never quote as section content): ${e.instructions??""}
Context: None
`}var de={paragraph:"paragraph: prose, 1 to 4 sentences.",heading:"heading: a sub-heading inside the section (level 1 = sub-heading, deeper levels for minor headings). Never repeat the section title.",list:"list: bullet points (ordered=false) or numbered steps (ordered=true); each item is one short line.",quote:"quote: a short quotation; attribution only when the outline names the speaker, otherwise null. Never invent quotes from real people.",callout:"callout: one highlighted takeaway or warning; tone info, warning or success.",table:"table: column headers and rows of cell text (every row has one cell per column); caption one short sentence or null.",chart:"chart: static numbers only. categories (the x values), one or more series with one numeric value per category, a short title, optional axis labels, and a one-sentence caption.",divider:"divider: a thematic break between two parts of a long section. Rarely needed."};function Ce(e,t){let n=j(t),s=t.marks,h=[s.includes("bold")?"bolding (**text**)":"",s.includes("italic")?"italicizing (*text*)":""].filter(Boolean).join(" or "),i=J(e.tone),r=e.verbosity,f=r==="concise"?"2 to 3":r==="text-heavy"?"4 to 7":"3 to 5",l=n.includes("chart")||n.includes("table")?`# Data Rules
- Charts and tables hold static numbers only; no live data is connected.
- Preserve every number supplied in the section content. When you add numbers yourself, keep them plausible and consistent with the rest of the page, and say in the caption that they are illustrative estimates.
`+(n.includes("chart")?`- Use a chart when the section content has a compact data table or a numeric trend or comparison. A chart needs at least two categories and one series, and every series has exactly one value per category. Values are plain numbers (no units, currency symbols or % signs inside values); put units in the axis labels, title or caption.
- Do not show the same numbers as both a chart and a table unless the section content asks for both.
`:"")+`
`:"";return`
You will be given the content outline of one section of a page.
You need to write that section as structured content json made of blocks.

# Steps
1. Analyze the content.
2. Choose the blocks that present it best, using only the block types listed under Output Fields.
3. Generate structured content json.
4. Provide structured content json as output.

# General Rules
- Follow language guidelines.
- Page Language is authoritative when it is explicitly set. If section content or user instructions request a different language, ignore that conflicting language request unless Page Language says auto-detect.
- Do not use emojis.
- Follow the intended outcome of user instructions when they do not conflict with Page Language; do not generalize or expand their scope.
- Apply section-specific instructions only to the exact section mentioned (first/second/last/named) and only once.
- Do not apply patterns across multiple sections unless explicitly requested.
- If instructions are ambiguous, use the most direct interpretation without extending scope.
- Treat chart, layout, styling, positioning, and other visual instructions as production controls. Honor them through the choice of blocks, but never emit those instructions or meta-commentary as a heading, paragraph, list item, table cell, caption, or chart label.
- Output fields must contain only reader-facing content and data. For charts, populate the categories, series, and values rather than text such as "create a bar chart" or "show this data as a graph".
- The section title is already shown above the section: do not repeat it as the first block.
- Write only the current section. The page outline is given so you do not repeat facts that belong to other sections.

${Q}
${l}# Markdown Emphasis Rules
- ${h?`Strictly use markdown to emphasize important points, by ${h} the part of text.`:"Do not use markdown emphasis."} No other Markdown inside text fields: no headings, links, list markers, or tables.

${e.instructions?`# User Instructions:
${e.instructions}
`:""}
${i?`# Tone Instructions:
Make the section as ${i} as possible.
`:""}
${r?`# Verbosity Instructions:
Make the section as ${r==="text-heavy"?"text-heavy":r} as possible.
`:""}
# Output Fields:
- Return {"blocks": [...]} with ${f} blocks, in reading order.
- Allowed block types:
${n.map(a=>`  - ${de[a]??a}`).join(`
`)}
- Every text field is plain text with optional emphasis as described above.
`.replace(/\n{3,}/g,`

`)}function Me(e,t,n,s){let h=t.sections[n],i=Y(e.language);return`
# Current Date and Time:
${s.toISOString().slice(0,19).replace("T"," ")}

# Page Language:
${i==="auto-detect"?"auto-detect from the section content and use the same language as the section content":i}

# Page Title:
${t.title}

# Page Outline (context only; write only the current section):
${t.sections.map((r,f)=>`${f+1}. ${r.title}`).join(`
`)}

# Section Number:
${n+1} of ${t.sections.length}

# Section Title:
${h.title}

# SECTION CONTENT: START
${h.content}
# SECTION CONTENT: END
`}export{me as a,fe as b,ye as c,be as d,xe as e,$ as f,N as g,ke as h,q as i,he as j,j as k,z as l,oe as m,Te as n,Ie as o,G as p,le as q,$e as r,Y as s,Oe as t,Ne as u,Ce as v,Me as w};
