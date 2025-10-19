import type { Plugin } from 'vite';

import path from 'path';
import { readFileSync, writeFileSync } from 'fs';

export interface NonModuleScriptProcessorOptions {
    htmlPath?: string;
}

interface NonModuleScript {
    originalPath: string;
    fullPath: string;
    hashedFileName: string;
}

/**
 * Vite плагин для автоматической обработки не-модульных JavaScript скриптов
 *
 * Функциональность:
 * - Автоматически находит все локальные скрипты в HTML (не модули, не внешние)
 * - В dev режиме: файлы доступны по оригинальным путям
 * - В prod режиме: файлы хэшируются и пути в HTML автоматически обновляются
 *
 * @param options - Опции плагина
 * @returns Vite плагин
 */
export function nonModuleScriptProcessor(
    options: NonModuleScriptProcessorOptions = {}
): Plugin {
    const { htmlPath = 'index.html' } = options;
    const nonModuleScripts: NonModuleScript[] = [];

    function isLocalScript(src: string): boolean {
        return (
            !src.startsWith('http://') &&
            !src.startsWith('https://') &&
            !src.startsWith('//')
        );
    }

    function findNonModuleScripts(): NonModuleScript[] {
        const fullHtmlPath = path.resolve(process.cwd(), htmlPath);

        try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            const htmlContent = readFileSync(fullHtmlPath, 'utf-8');
            const scripts: NonModuleScript[] = [];

            const scriptRegex =
                /<script(?![^>]*type\s*=\s*["']module["'])[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

            let match;
            while ((match = scriptRegex.exec(htmlContent)) !== null) {
                const src = match[1];

                if (isLocalScript(src)) {
                    // Убираем ведущий слэш для корректного path.resolve
                    const cleanSrc = src.startsWith('/') ? src.slice(1) : src;
                    const fullPath = path.resolve(process.cwd(), cleanSrc);

                    scripts.push({
                        originalPath: src,
                        fullPath,
                        hashedFileName: '',
                    });
                }
            }

            return scripts;
        } catch (error) {
            console.error(
                `[non-module-script-processor] Error reading HTML file:`,
                error
            );
            return [];
        }
    }

    return {
        name: 'non-module-script-processor',

        generateBundle() {
            const foundScripts = findNonModuleScripts();

            for (const script of foundScripts) {
                try {
                    // eslint-disable-next-line security/detect-non-literal-fs-filename
                    const scriptContent = readFileSync(
                        script.fullPath,
                        'utf-8'
                    );
                    const fileName = path.basename(script.fullPath);
                    const scriptHash = this.emitFile({
                        type: 'asset',
                        name: fileName,
                        source: scriptContent,
                    });

                    script.hashedFileName = this.getFileName(scriptHash);
                    nonModuleScripts.push(script);
                } catch (error) {
                    console.error(
                        `[non-module-script-processor] Error reading script file ${script.fullPath}:`,
                        error
                    );
                }
            }
        },

        closeBundle() {
            if (nonModuleScripts.length === 0) return;

            const htmlPath = path.resolve(process.cwd(), 'dist', 'index.html');

            try {
                let htmlContent = readFileSync(htmlPath, 'utf-8');

                for (const script of nonModuleScripts) {
                    const oldPath = script.originalPath;
                    const newPath = `/${script.hashedFileName}`;

                    htmlContent = htmlContent.replace(
                        // eslint-disable-next-line security/detect-non-literal-regexp
                        new RegExp(
                            `src\\s*=\\s*["']${oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
                            'g'
                        ),
                        `src="${newPath}"`
                    );
                }

                writeFileSync(htmlPath, htmlContent);
            } catch (error) {
                console.error(
                    `[non-module-script-processor] Error updating HTML:`,
                    error
                );
            }
        },
    };
}
