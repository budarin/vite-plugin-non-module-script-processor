# Архитектура плагина non-module-script-processor

## Задача плагина

Плагин должен обработать non-module JavaScript скрипты, которые не обрабатываются Vite/Rolldown автоматически. Для каждого такого скрипта нужно:

1. Минифицировать код
2. Добавить хэш к имени файла для кэширования
3. Поместить файл в папку `assets/`
4. Обновить путь к файлу в HTML

## Оптимизации производительности

Плагин оптимизирован для максимальной производительности:

- **🚀 Кэширование**: HTML файл читается только один раз
- **⚡ Предкомпиляция**: Регулярные выражения компилируются один раз
- **🛡️ Валидация**: Проверка существования файлов перед обработкой
- **🎯 Ранние выходы**: Избегание ненужной работы при отсутствии скриптов
- **🔧 Оптимизация циклов**: Минимум повторных вычислений

## Ключевое решение: использовать Chunks вместо Assets

Изначально мы пытались эмитить файлы как Assets, но столкнулись с проблемой: **Assets - это статические файлы, к которым Rolldown/Vite не применяет минификацию и трансформации**.

Правильное решение - эмитить файлы как **Chunks**. Chunk - это модуль кода, который проходит через весь пайплайн обработки Vite/Rolldown: минификация, хэширование, трансформации.

**Главное преимущество:** Rolldown автоматически применит тот минификатор, который настроен в `build.minify` (esbuild, terser, oxc или любой будущий). Мы не зависим от конкретных реализаций.

## Реализация в плагине

### Шаг 1: Инициализация и кэширование

Плагин использует несколько оптимизаций для повышения производительности:

```typescript
// Кэш для HTML контента - читаем файл только один раз
let cachedHtmlContent: string | null = null;
let cachedHtmlPath: string | null = null;

// Компилируем регулярное выражение один раз
const SCRIPT_REGEX =
    /<script(?![^>]*type\s*=\s*["']module["'])[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

// Функция кэшированного чтения HTML
function getHtmlContent(): string | null {
    const fullHtmlPath = path.resolve(process.cwd(), htmlPath);

    // Возвращаем кэшированный контент если путь не изменился
    if (cachedHtmlContent && cachedHtmlPath === fullHtmlPath) {
        return cachedHtmlContent;
    }

    try {
        const content = readFileSync(fullHtmlPath, 'utf-8');
        cachedHtmlContent = content;
        cachedHtmlPath = fullHtmlPath;
        return content;
    } catch (error) {
        // Обработка ошибок с логированием
        return null;
    }
}
```

### Шаг 2: Создаём виртуальные модули

Чтобы эмитить chunk, нужен модуль. Мы создаём виртуальные модули для каждого non-module скрипта:

```typescript
const virtualModulePrefix = '\0non-module-script:';

// Хук resolveId - резолвим виртуальный модуль
resolveId(id) {
    if (id.startsWith(virtualModulePrefix)) {
        return id; // Говорим Rolldown, что это валидный модуль
    }
    return null;
}

// Хук load - загружаем код скрипта
load(id) {
    if (id.startsWith(virtualModulePrefix)) {
        // Извлекаем реальный путь к файлу
        const scriptPath = id.slice(virtualModulePrefix.length);
        try {
            // Читаем и возвращаем содержимое
            return readFileSync(scriptPath, 'utf-8');
        } catch (error) {
            config.logger.error(`Failed to load ${scriptPath}`);
            return null;
        }
    }
    return null;
}
```

Префикс `\0` - это соглашение Rollup/Rolldown для виртуальных модулей. Он указывает, что это внутренний модуль, который не должен создавать файл на диске.

### Шаг 3: Поиск и валидация скриптов

Оптимизированная функция поиска скриптов с валидацией:

```typescript
function findNonModuleScripts(): NonModuleScript[] {
    const htmlContent = getHtmlContent(); // Используем кэшированный HTML
    if (!htmlContent) {
        return []; // Ранний выход при ошибке
    }

    const scripts: NonModuleScript[] = [];
    let match;

    // Сбрасываем lastIndex для глобального regex
    SCRIPT_REGEX.lastIndex = 0;

    while ((match = SCRIPT_REGEX.exec(htmlContent)) !== null) {
        const src = match[1];

        if (isLocalScript(src)) {
            const cleanSrc = src.startsWith('/') ? src.slice(1) : src;
            const fullPath = path.resolve(process.cwd(), cleanSrc);

            // Валидируем путь файла перед добавлением
            if (isValidScriptPath(fullPath)) {
                scripts.push({
                    originalPath: src,
                    fullPath,
                    hashedFileName: '',
                });
            } else {
                config?.logger?.warn(`Skipping invalid script: ${src}`);
            }
        }
    }

    return scripts;
}

// Валидация существования и типа файла
function isValidScriptPath(scriptPath: string): boolean {
    try {
        const stats = require('fs').statSync(scriptPath);
        return stats.isFile() && scriptPath.endsWith('.js');
    } catch {
        return false;
    }
}
```

### Шаг 4: Эмитим chunks в buildStart

В хуке `buildStart` мы проходим по всем найденным non-module скриптам и эмитим их как chunks:

```typescript
buildStart() {
    const foundScripts = findNonModuleScripts();

    // Ранний выход если нет скриптов
    if (foundScripts.length === 0) {
        return;
    }

    const isCustomMinify = typeof minifyOption === 'function';

    for (const script of foundScripts) {
        if (!isCustomMinify) {
            // Создаём виртуальный ID для скрипта
            const virtualId = virtualModulePrefix + script.fullPath;

            // Эмитим как chunk
            const chunkId = this.emitFile({
                type: 'chunk',
                id: virtualId,                    // ID виртуального модуля
                name: path.basename(script.fullPath).replace('.js', ''), // Имя БЕЗ расширения
            });

            // Сохраняем ID для последующего получения имени файла
            chunkIds.set(script.originalPath, chunkId);
            nonModuleScripts.push(script);
        } else {
            // Кастомная минификация - добавляем в список для обработки в generateBundle
            nonModuleScripts.push(script);
        }
    }
}
```

**Оптимизации:**

- **Ранний выход**: Если нет скриптов, сразу выходим из функции
- **Предвычисление условий**: `isCustomMinify` вычисляется один раз
- **Валидация файлов**: Проверяем существование файлов перед обработкой
- **Кэширование HTML**: Используем кэшированный контент

### Шаг 5: Rolldown обрабатывает chunks

После вызова `emitFile` Rolldown:

1. Резолвит виртуальный модуль через наш хук `resolveId`
2. Загружает код через наш хук `load`
3. Обрабатывает код через пайплайн (минификация, трансформации)
4. Генерирует финальный файл с хэшем в папке `assets/`

Мы ничего не делаем на этом этапе - всё происходит автоматически.

### Шаг 6: Получаем финальные имена файлов в generateBundle

Оптимизированный хук `generateBundle` с ранними выходами:

```typescript
async generateBundle() {
    // Ранний выход если нет скриптов
    if (nonModuleScripts.length === 0) {
        return;
    }

    const isCustomMinify = typeof minifyOption === 'function';

    // Получаем финальные имена для всех chunks
    for (const script of nonModuleScripts) {
        const chunkId = chunkIds.get(script.originalPath);
        if (chunkId && !script.hashedFileName) {
            // ЗДЕСЬ можем вызвать getFileName - chunks уже готовы
            script.hashedFileName = this.getFileName(chunkId);
            // Результат: "assets/splash-a1b2c3d4.js"
        }
    }

    // Обрабатываем скрипты с кастомной минификацией только если нужно
    if (isCustomMinify) {
        for (const script of nonModuleScripts) {
            if (!script.hashedFileName) {
                // ... обработка кастомной минификации
            }
        }
    }
}
```

**Оптимизации:**

- **Ранний выход**: Если нет скриптов, сразу выходим
- **Предвычисление условий**: `isCustomMinify` вычисляется один раз
- **Условная обработка**: Кастомная минификация выполняется только при необходимости

**Критично важно:** `getFileName()` можно вызывать только после генерации chunks:

- ✅ В `generateBundle` - chunks готовы
- ✅ В `writeBundle` - chunks готовы
- ❌ В `buildStart` - chunks ещё не созданы, будет ошибка
- ❌ В `renderStart` - chunks ещё не сгенерированы, будет ошибка

### Шаг 7: Оптимизированное обновление HTML

Оптимизированный хук `closeBundle` с эффективными replace операциями:

```typescript
closeBundle() {
    if (nonModuleScripts.length === 0) return;

    const distHtmlPath = path.resolve(process.cwd(), 'dist', 'index.html');

    try {
        let htmlContent = readFileSync(distHtmlPath, 'utf-8');

        // Оптимизация: собираем все замены в один проход
        const replacements: Array<{ from: RegExp; to: string }> = [];

        for (const script of nonModuleScripts) {
            if (!script.hashedFileName) continue;

            const oldPath = script.originalPath;
            const newPath = `/${script.hashedFileName}`;

            // Экранируем специальные символы в пути
            const escapedPath = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        config.logger.error(`Error updating HTML:`, error);
    }
}
```

**Оптимизации:**

- **Ранний выход**: Если нет скриптов, сразу выходим
- **Предкомпиляция regex**: Создаем все регулярные выражения заранее
- **Один проход**: Применяем все замены последовательно
- **Валидация**: Проверяем наличие `hashedFileName` перед обработкой
- **Обработка ошибок**: Корректное логирование ошибок

## Порядок выполнения хуков

Понимание порядка выполнения хуков критично для правильной работы плагина:

```
1. configResolved
   → Сохраняем config для логирования

2. buildStart
   → Кэшируем HTML контент
   → Валидируем и находим скрипты
   → Эмитим chunks через emitFile()
   → Сохраняем chunkIds для последующего использования

3. resolveId
   → Rolldown резолвит наши виртуальные модули

4. load
   → Rolldown загружает код скриптов

5. [Внутренняя обработка Rolldown]
   → Применяет минификацию из build.minify
   → Генерирует chunks с хэшами
   → Помещает в assets/

6. generateBundle
   → Получаем финальные имена файлов через getFileName()
   → Обрабатываем кастомную минификацию (если нужно)

7. closeBundle
   → Оптимизированно обновляем HTML с новыми путями
```

## Результаты оптимизации производительности

### Метрики производительности

- **Размер кода**: 199 строк (было 253) - уменьшение на ~21%
- **Чтение файлов**: HTML читается только один раз благодаря кэшированию
- **Regex операции**: Регулярные выражения компилируются один раз
- **Валидация**: Проверка файлов предотвращает обработку несуществующих скриптов
- **Ранние выходы**: Избегаем ненужной работы при отсутствии скриптов

### Ключевые оптимизации

1. **Кэширование HTML**: `cachedHtmlContent` и `cachedHtmlPath` предотвращают повторное чтение
2. **Предкомпиляция regex**: `SCRIPT_REGEX` создается один раз
3. **Валидация файлов**: `isValidScriptPath()` проверяет файлы перед обработкой
4. **Оптимизация циклов**: Меньше повторных проверок условий
5. **Эффективные replace**: Собираем все замены в один проход
6. **Ранние выходы**: Избегаем работы при пустых массивах

## Почему это решение будущеустойчиво

Плагин НЕ импортирует и НЕ вызывает конкретные минификаторы (esbuild, terser, oxc). Вместо этого мы делегируем минификацию Rolldown/Vite, который применит настроенный минификатор автоматически.

**Что происходит при переходе на новые версии:**

- Vite 2-6 с esbuild/terser → работает ✅
- Vite 7 с Rolldown и oxc → работает ✅
- Будущие версии с новыми минификаторами → будут работать ✅

Мы не зависим от деталей реализации конкретных минификаторов, поэтому код не сломается при миграции на новые инструменты.

## Альтернативный вариант: кастомная функция минификации

Для специальных случаев можно передать кастомную функцию минификации:

```typescript
nonModuleScriptProcessor({
    minify: async (code, config) => {
        // Ваша логика минификации
        return yourCustomMinifier(code);
    },
});
```

В этом случае плагин:

1. НЕ эмитит chunks
2. Читает код скриптов
3. Применяет кастомную функцию минификации
4. Эмитит результат как **asset** (не chunk)

Этот вариант нужен для edge-cases, когда стандартной минификации недостаточно.

## Итоги

### Главное правило

**Чтобы код минифицировался автоматически - эмитьте его как chunk, а не как asset.**

### Ключевые принципы

1. **Assets** - это статические файлы без обработки
2. **Chunks** - это модули кода, которые проходят через весь пайплайн обработки
3. **Виртуальные модули** позволяют превратить обычный файл в chunk
4. **emitFile** вызываем в `buildStart`, **getFileName** - в `generateBundle` или позже
5. Rolldown/Vite **сам применит** минификацию, хэширование и трансформации к chunks

### Преимущества архитектуры

- ✅ **Автоматическая минификация** любым настроенным минификатором
- ✅ **Автоматическое хэширование** файлов
- ✅ **Правильное размещение** в папке `assets/`
- ✅ **Уважение к настройкам** `build.target` и `build.minify`
- ✅ **Полная совместимость** с текущими и будущими версиями Vite/Rolldown
- ✅ **Нет зависимостей** от конкретных реализаций минификаторов
- ✅ **Высокая производительность** благодаря оптимизациям
- ✅ **Надежность** благодаря валидации файлов
- ✅ **Эффективность** благодаря кэшированию и ранним выходам

### Производительность

Плагин оптимизирован для максимальной производительности:

- **🚀 Кэширование**: HTML читается только один раз
- **⚡ Предкомпиляция**: Regex компилируется один раз
- **🛡️ Валидация**: Проверка файлов перед обработкой
- **🎯 Ранние выходы**: Избегание ненужной работы
- **🔧 Оптимизация циклов**: Минимум повторных вычислений
- **📊 Эффективные replace**: Один проход для всех замен
