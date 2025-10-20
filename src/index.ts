import type { Plugin, ResolvedConfig } from 'vite';

import path from 'path';
import { readFileSync, writeFileSync } from 'fs';

// Константы
const VIRTUAL_MODULE_PREFIX = '\0non-module-script:';
const SCRIPT_REGEX =
    /<script(?![^>]*type\s*=\s*["']module["'])[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const REGEX_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

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
    const chunkIds = new Map<string, string>(); // originalPath -> chunkId

    // Кэш для HTML контента
    let cachedHtmlContent: string | null = null;
    let cachedHtmlPath: string | null = null;

    function getHtmlContent(): string | null {
        const fullHtmlPath = path.resolve(process.cwd(), htmlPath);

        // Возвращаем кэшированный контент если путь не изменился
        if (cachedHtmlContent && cachedHtmlPath === fullHtmlPath) {
            return cachedHtmlContent;
        }

        try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            const content = readFileSync(fullHtmlPath, 'utf-8');
            cachedHtmlContent = content;
            cachedHtmlPath = fullHtmlPath;
            return content;
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
            return null;
        }
    }

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
            !src.startsWith('//') &&
            src.length > 0 // Проверяем что строка не пустая
        );
    }

    function isValidScriptPath(scriptPath: string): boolean {
        // Проверяем только расширение файла
        // Не проверяем существование файла, так как он может быть создан позже
        return scriptPath.endsWith('.js') || scriptPath.endsWith('.mjs');
    }

    function findNonModuleScripts(): NonModuleScript[] {
        const htmlContent = getHtmlContent();
        if (!htmlContent) {
            return [];
        }

        const scripts: NonModuleScript[] = [];
        let match;

        // Сбрасываем lastIndex для глобального regex
        SCRIPT_REGEX.lastIndex = 0;

        while ((match = SCRIPT_REGEX.exec(htmlContent)) !== null) {
            const src = match[1];

            if (isLocalScript(src)) {
                // Убираем ведущий слэш для корректного path.resolve
                const cleanSrc = src.startsWith('/') ? src.slice(1) : src;
                const fullPath = path.resolve(process.cwd(), cleanSrc);

                // Валидируем путь файла
                if (isValidScriptPath(fullPath)) {
                    scripts.push({
                        originalPath: src,
                        fullPath,
                        hashedFileName: '',
                    });
                } else {
                    config?.logger?.warn(
                        `[non-module-script-processor] Skipping invalid script: ${src}`
                    );
                }
            }
        }

        return scripts;
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

            // Ранний выход если нет скриптов
            if (foundScripts.length === 0) {
                return;
            }

            const isCustomMinify = typeof minifyOption === 'function';

            for (const script of foundScripts) {
                if (!isCustomMinify) {
                    // Эмитим как chunk - тогда Rolldown/Vite автоматически применит минификацию!
                    const fileName = path.basename(script.fullPath);
                    const virtualId = VIRTUAL_MODULE_PREFIX + script.fullPath;

                    const chunkId = this.emitFile({
                        type: 'chunk',
                        id: virtualId,
                        // НЕ указываем fileName - Rolldown сам добавит хэш и положит в assets
                        name: fileName.replace('.js', ''),
                    });

                    // Сохраняем chunkId - имя файла получим позже в renderStart
                    chunkIds.set(script.originalPath, chunkId);
                    nonModuleScripts.push(script);
                } else {
                    // Кастомная минификация - добавляем в список для обработки в generateBundle
                    nonModuleScripts.push(script);
                }
            }
        },

        resolveId(id) {
            // Резолвим виртуальные модули для наших скриптов
            if (id.startsWith(VIRTUAL_MODULE_PREFIX)) {
                return id;
            }
            return null;
        },

        load(id) {
            // Загружаем содержимое виртуального модуля
            if (id.startsWith(VIRTUAL_MODULE_PREFIX)) {
                const scriptPath = id.slice(VIRTUAL_MODULE_PREFIX.length);
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
            // Ранний выход если нет скриптов
            if (nonModuleScripts.length === 0) {
                return;
            }

            const isCustomMinify = typeof minifyOption === 'function';

            // Получаем имена файлов для emitted chunks ЗДЕСЬ - в generateBundle!
            for (const script of nonModuleScripts) {
                const chunkId = chunkIds.get(script.originalPath);
                if (chunkId && !script.hashedFileName) {
                    script.hashedFileName = this.getFileName(chunkId);
                }
            }

            // Обрабатываем скрипты с кастомной минификацией только если нужно
            if (isCustomMinify) {
                for (const script of nonModuleScripts) {
                    if (!script.hashedFileName) {
                        try {
                            // eslint-disable-next-line security/detect-non-literal-fs-filename
                            let scriptContent = readFileSync(
                                script.fullPath,
                                'utf-8'
                            );
                            scriptContent =
                                await minifyCodeWithCustomFunction(
                                    scriptContent
                                );

                            const fileName = path.basename(script.fullPath);
                            const scriptHash = this.emitFile({
                                type: 'asset',
                                name: fileName,
                                source: scriptContent,
                            });

                            script.hashedFileName =
                                this.getFileName(scriptHash);
                        } catch (error) {
                            config.logger.error(
                                `[non-module-script-processor] Error processing script file ${script.fullPath}:`
                            );
                            config.logger.error(String(error));
                        }
                    }
                }
            }
        },

        closeBundle() {
            if (nonModuleScripts.length === 0) return;

            const distHtmlPath = path.resolve(
                process.cwd(),
                'dist',
                'index.html'
            );

            try {
                let htmlContent = readFileSync(distHtmlPath, 'utf-8');

                // Оптимизация: собираем все замены в один проход
                const replacements: Array<{ from: RegExp; to: string }> = [];

                for (const script of nonModuleScripts) {
                    if (!script.hashedFileName) continue;

                    const oldPath = script.originalPath;
                    const newPath = `/${script.hashedFileName}`;

                    // Экранируем специальные символы в пути
                    const escapedPath = oldPath.replace(
                        REGEX_ESCAPE_PATTERN,
                        '\\$&'
                    );
                    const regex = new RegExp(
                        `src\\s*=\\s*["']${escapedPath}["']`,
                        'g'
                    );

                    replacements.push({ from: regex, to: `src="${newPath}"` });
                }

                // Применяем все замены за один проход
                for (const { from, to } of replacements) {
                    htmlContent = htmlContent.replace(from, to);
                }

                writeFileSync(distHtmlPath, htmlContent);
            } catch (error) {
                config.logger.error(
                    `[non-module-script-processor] Error updating HTML:`
                );
                config.logger.error(String(error));
            }
        },
    };
}
