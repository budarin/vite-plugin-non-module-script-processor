import type { Plugin, ResolvedConfig } from 'vite';

import path from 'path';
import { readFileSync, writeFileSync } from 'fs';

export type MinifyFunction = (
    code: string,
    config: ResolvedConfig
) => Promise<string> | string;

export interface NonModuleScriptProcessorOptions {
    htmlPath?: string;
    minify?: boolean | MinifyFunction; // undefined = авто (зависит от production режима), функция = кастомная минификация
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
    const { htmlPath = 'index.html', minify: minifyOption } = options;
    const nonModuleScripts: NonModuleScript[] = [];
    let config: ResolvedConfig;
    const virtualModulePrefix = '\0non-module-script:';
    const chunkIds = new Map<string, string>(); // originalPath -> chunkId

    async function minifyCodeWithCustomFunction(code: string): Promise<string> {
        // Используем кастомную функцию минификации если предоставлена
        if (typeof minifyOption === 'function') {
            try {
                return await minifyOption(code, config);
            } catch (error) {
                config.logger.warn(
                    `[non-module-script-processor] Custom minification failed, using original code`
                );
                config.logger.warn(String(error));
                return code;
            }
        }
        return code;
    }

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
            if (config?.logger) {
                config.logger.error(
                    `[non-module-script-processor] Error reading HTML file:`
                );
                config.logger.error(String(error));
            } else {
                console.error(
                    `[non-module-script-processor] Error reading HTML file:`,
                    error
                );
            }
            return [];
        }
    }

    return {
        name: 'non-module-script-processor',
        apply: 'build',

        configResolved(resolvedConfig) {
            // Получаем доступ к конфигу Vite
            config = resolvedConfig;
        },

        buildStart() {
            // Эмитим chunks в buildStart - это ранний хук где можно вызывать emitFile с type: 'chunk'
            const foundScripts = findNonModuleScripts();

            for (const script of foundScripts) {
                if (typeof minifyOption !== 'function') {
                    // Эмитим как chunk - тогда Rolldown/Vite автоматически применит минификацию!
                    const fileName = path.basename(script.fullPath);
                    const virtualId = virtualModulePrefix + script.fullPath;

                    const chunkId = this.emitFile({
                        type: 'chunk',
                        id: virtualId,
                        // НЕ указываем fileName - Rolldown сам добавит хэш и положит в assets
                        name: fileName.replace('.js', ''),
                    });

                    // Сохраняем chunkId - имя файла получим позже в renderStart
                    chunkIds.set(script.originalPath, chunkId);
                    nonModuleScripts.push(script);

                    // config.logger.info(
                    //     `[non-module-script-processor] Emitted ${script.originalPath} as chunk - will be minified by ${config.build.minify || 'none'}`
                    // );
                } else {
                    // Кастомная минификация - добавляем в список для обработки в generateBundle
                    nonModuleScripts.push(script);
                }
            }
        },

        resolveId(id) {
            // Резолвим виртуальные модули для наших скриптов
            if (id.startsWith(virtualModulePrefix)) {
                return id;
            }
            return null;
        },

        load(id) {
            // Загружаем содержимое виртуального модуля
            if (id.startsWith(virtualModulePrefix)) {
                const scriptPath = id.slice(virtualModulePrefix.length);
                try {
                    // eslint-disable-next-line security/detect-non-literal-fs-filename
                    const content = readFileSync(scriptPath, 'utf-8');
                    // Экспортируем пустой объект чтобы это был валидный модуль
                    // Но в chunk будет только наш код
                    return content;
                } catch (error) {
                    config.logger.error(
                        `[non-module-script-processor] Failed to load ${scriptPath}`
                    );
                    return null;
                }
            }
            return null;
        },

        async generateBundle() {
            // Получаем имена файлов для emitted chunks ЗДЕСЬ - в generateBundle!
            for (const script of nonModuleScripts) {
                const chunkId = chunkIds.get(script.originalPath);
                if (chunkId && !script.hashedFileName) {
                    script.hashedFileName = this.getFileName(chunkId);
                }
            }

            // Обрабатываем скрипты с кастомной минификацией
            for (const script of nonModuleScripts) {
                if (
                    typeof minifyOption === 'function' &&
                    !script.hashedFileName
                ) {
                    try {
                        // eslint-disable-next-line security/detect-non-literal-fs-filename
                        let scriptContent = readFileSync(
                            script.fullPath,
                            'utf-8'
                        );
                        scriptContent =
                            await minifyCodeWithCustomFunction(scriptContent);

                        const fileName = path.basename(script.fullPath);
                        const scriptHash = this.emitFile({
                            type: 'asset',
                            name: fileName,
                            source: scriptContent,
                        });

                        script.hashedFileName = this.getFileName(scriptHash);
                    } catch (error) {
                        config.logger.error(
                            `[non-module-script-processor] Error processing script file ${script.fullPath}:`
                        );
                        config.logger.error(String(error));
                    }
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
                config.logger.error(
                    `[non-module-script-processor] Error updating HTML:`
                );
                config.logger.error(String(error));
            }
        },
    };
}
