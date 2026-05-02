import { forwardRef, useCallback, useImperativeHandle, useRef, type ChangeEvent, type DragEvent } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface FileUploadToolbarHandle {
  openPicker: () => void;
  clear: () => void;
}

interface FileUploadToolbarProps {
  accept: string;
  disabled?: boolean;
  loading?: boolean;
  file: File | null;
  onFileChange: (file: File | null) => void;
  hint: string;
  className?: string;
}

/**
 * Drag-and-drop + file picker region. Uses imperative handle to open the hidden input (forwardRef pattern on the handle).
 */
export const FileUploadToolbar = forwardRef<FileUploadToolbarHandle, FileUploadToolbarProps>(
  function FileUploadToolbar(
    { accept, disabled, loading, file, onFileChange, hint, className },
    ref,
  ) {
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      openPicker: () => inputRef.current?.click(),
      clear: () => {
        if (inputRef.current) inputRef.current.value = '';
        onFileChange(null);
      },
    }));

    const onPick = useCallback(
      (f: File | null) => {
        onFileChange(f);
      },
      [onFileChange],
    );

    const handleInput = (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0] ?? null;
      onPick(f);
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      if (disabled || loading) return;
      const f = e.dataTransfer.files?.[0];
      if (f) onPick(f);
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };

    return (
      <div className={cn('space-y-2', className)}>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          disabled={disabled || loading}
          onChange={handleInput}
        />
        <button
          type="button"
          disabled={disabled || loading}
          onClick={() => inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className={cn(
            'flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm transition-colors',
            disabled || loading
              ? 'cursor-not-allowed border-muted-foreground/20 opacity-60'
              : 'border-muted-foreground/30 hover:border-ring/50 hover:bg-muted/30',
          )}
        >
          {loading ? (
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          ) : (
            <FileUp className="size-8 text-muted-foreground" />
          )}
          <span className="font-medium text-foreground">
            {file ? file.name : 'Hidhni skedarin këtu ose klikoni për të zgjedhur'}
          </span>
          <span className="text-xs text-muted-foreground">{hint}</span>
        </button>
      </div>
    );
  },
);
