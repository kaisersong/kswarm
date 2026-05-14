/**
 * ArtifactPreviewModal — inline preview with Markdown rendering, HTML iframe, JSON formatting.
 */

import { useState, useEffect } from 'react';
import { X, Download } from 'lucide-react';

export function ArtifactPreviewModal({ artifact, onClose }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const isPreviewable = /\.(md|markdown|html|htm|txt|json|svg)$/i.test(artifact.name || '') ||
    /text|json|html|markdown|svg/.test(artifact.mimeType || '');

  useEffect(() => {
    if (!isPreviewable) { setLoading(false); return; }
    const loadContent = async () => {
      try {
        const url = artifact.url || (artifact.path ? `file://${artifact.path}` : null);
        if (!url) { setError('无可用路径'); setLoading(false); return; }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        setContent(await res.text());
      } catch (err) { setError(err.message); }
      finally { setLoading(false); }
    };
    loadContent();
  }, [artifact, isPreviewable]);

  const handleDownload = () => {
    const url = artifact.url || (artifact.path ? `file://${artifact.path}` : null);
    if (url) window.open(url, '_blank');
  };

  const isHtml = /\.(html|htm|svg)$/i.test(artifact.name || '') || artifact.mimeType?.includes('html') || artifact.mimeType?.includes('svg');
  const isJson = /\.json$/i.test(artifact.name || '') || artifact.mimeType?.includes('json');
  const isMarkdown = /\.(md|markdown)$/i.test(artifact.name || '') || artifact.mimeType?.includes('markdown');

  const renderMarkdown = (md) => {
    const html = md
      .replace(/^## (.+)$/gm, '<h2 style="font-size:15px;font-weight:600;margin:12px 0 6px;color:var(--tw-prose-headings)">$1</h2>')
      .replace(/^### (.+)$/gm, '<h3 style="font-size:13px;font-weight:600;margin:10px 0 4px;color:#d4d4d8">$1</h3>')
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e4e4e7">$1</strong>')
      .replace(/^- (.+)$/gm, '<li style="margin-left:16px;color:#a1a1aa;font-size:12px">$1</li>')
      .replace(/^(\d+)\. (.+)$/gm, '<li style="margin-left:16px;color:#a1a1aa;font-size:12px">$1. $2</li>')
      .replace(/`([^`]+)`/g, '<code style="background:#27272a;padding:1px 4px;border-radius:3px;font-size:11px">$1</code>')
      .replace(/\n\n/g, '<br/><br/>')
      .replace(/\n/g, '<br/>');
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  };

  const renderContent = () => {
    if (loading) return <div className="flex items-center justify-center py-12"><div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" /></div>;
    if (error) return <p className="py-8 text-center text-sm text-red-400">加载失败: {error}</p>;
    if (!isPreviewable) return <p className="py-8 text-center text-sm text-gray-500">此文件类型不支持预览</p>;
    if (!content) return <p className="py-8 text-center text-sm text-gray-500">内容为空</p>;
    if (isHtml) return <iframe srcDoc={content} className="h-[60vh] w-full rounded-lg border border-gray-200 bg-white" sandbox="allow-same-origin" title={artifact.name} />;
    if (isMarkdown) return <div className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-4 text-[13px] text-gray-900">{renderMarkdown(content)}</div>;
    if (isJson) {
      try { return <pre className="max-h-[60vh] overflow-auto rounded-lg bg-gray-50 p-4 text-[12px] font-mono text-gray-900">{JSON.stringify(JSON.parse(content), null, 2)}</pre>; } catch {}
    }
    return <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-4 text-[13px] text-gray-900">{content}</pre>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8" onClick={onClose}>
      <div className="relative w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-2xl border border-gray-300 bg-gray-50 shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-gray-900 truncate">{artifact.name}</p>
            <p className="text-[10px] text-gray-500">{artifact.mimeType || '未知类型'}</p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={handleDownload} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900" title="下载"><Download size={15} /></button>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"><X size={15} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{renderContent()}</div>
      </div>
    </div>
  );
}
