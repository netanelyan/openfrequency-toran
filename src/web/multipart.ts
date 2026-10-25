// A multipart/form-data body (a form with a file), parsed with no library: the fields as strings, the files as
// bytes. Only the inbox's reply form sends one (server.ts lets it, and only it, be this big).

export type Upload = { field: string; name: string; type: string; bytes: Buffer };

export function boundaryOf(contentType: string): string | null {
  const m = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(String(contentType || ''));
  return m ? m[1] || m[2] : null;
}

export function parseMultipart(body: Buffer, boundary: string): { fields: Record<string, string>; files: Upload[] } {
  const fields: Record<string, string> = {};
  const files: Upload[] = [];
  const delim = Buffer.from(`--${boundary}`);
  let at = body.indexOf(delim);
  while (at !== -1) {
    const start = at + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') break; // the closing delimiter
    const next = body.indexOf(delim, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2); // past the CRLF after the delimiter, before the CRLF ahead of the next
    at = next;
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const head = part.subarray(0, split).toString('utf8');
    const content = part.subarray(split + 4);
    const disp = /^content-disposition:\s*form-data(.*)$/im.exec(head)?.[1] || '';
    const name = /;\s*name="([^"]*)"/i.exec(disp)?.[1];
    if (!name) continue;
    const filename = /;\s*filename="([^"]*)"/i.exec(disp)?.[1];
    if (filename === undefined) fields[name] = content.toString('utf8');
    else if (filename || content.length) files.push({ field: name, name: filename, type: /^content-type:\s*([^\r\n;]+)/im.exec(head)?.[1].trim().toLowerCase() || '', bytes: Buffer.from(content) });
  }
  return { fields, files };
}
