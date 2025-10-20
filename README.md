# vite-plugin-non-module-script-processor

Vite плагин для автоматической обработки не-модульных JavaScript скриптов.

## Проблема

Vite по умолчанию **не обрабатывает** обычные JavaScript скрипты (не модули) в HTML файлах. Такие скрипты часто используются для:

- 🔧 Инициализации данных на странице до загрузки модулей
- ⚡ Немедленной обработки критически важных данных
- 🎯 Настройки глобальных переменных и конфигурации
- 📊 Аналитики и трекинга, которые должны сработать сразу

Но Vite их игнорирует, что означает:

- ❌ Скрипты не хэшируются в production сборке
- ❌ Пути к скриптам не обновляются автоматически
- ❌ Скрипты не проходят через Vite pipeline для оптимизации
- ❌ Нет поддержки hot reload для обычных скриптов

## Решение

Этот плагин автоматически находит все локальные не-модульные скрипты в HTML и:

- ✅ **В dev режиме**: скрипты доступны по оригинальным путям
- ✅ **В prod режиме**: скрипты хэшируются и пути в HTML автоматически обновляются
- ✅ **Минификация**: автоматическая минификация скриптов с использованием esbuild или terser из Vite
- ✅ **Автоматическое обнаружение**: находит все `<script>` теги без `type="module"`
- ✅ **Исключение внешних скриптов**: игнорирует CDN и внешние ссылки

## Установка

```bash
npm install @budarin/vite-plugin-non-module-script-processor
# или
pnpm add @budarin/vite-plugin-non-module-script-processor
# или
yarn add @budarin/vite-plugin-non-module-script-processor
```

**Примечание:** Плагин автоматически использует встроенный минификатор Vite (esbuild или terser), никаких дополнительных зависимостей не требуется!

## Использование

### Базовая настройка

```typescript
import { defineConfig } from 'vite';
import { nonModuleScriptProcessor } from '@budarin/vite-plugin-non-module-script-processor';

export default defineConfig({
    plugins: [
        nonModuleScriptProcessor({
            htmlPath: 'index.html', // опционально, по умолчанию 'index.html'
            minify: undefined, // опционально, undefined = авто (только в production)
        }),
    ],
});
```

### С настройками минификации

```typescript
export default defineConfig({
    plugins: [
        nonModuleScriptProcessor({
            minify: true, // принудительно включить минификацию
        }),
    ],
    build: {
        minify: true, // используем минификацию на проекте
        terserOptions: {
            compress: {
                drop_console: true, // удалить console.* в production
            },
        },
    },
});
```

### С кастомной функцией минификации

```typescript
import { defineConfig } from 'vite';
import { nonModuleScriptProcessor } from '@budarin/vite-plugin-non-module-script-processor';

export default defineConfig({
    plugins: [
        nonModuleScriptProcessor({
            // Кастомная функция минификации
            // Полезно для будущих версий Vite с новыми минификаторами
            minify: async (code, config) => {
                // Используйте любой минификатор
                const customMinifier = await import('your-minifier');
                return customMinifier.minify(code);
            },
        }),
    ],
});
```

### Для Rolldown/Vite 7+ с oxc минификатором

```typescript
import { defineConfig } from 'vite';
import { nonModuleScriptProcessor } from '@budarin/vite-plugin-non-module-script-processor';

export default defineConfig({
    plugins: [
        nonModuleScriptProcessor({
            htmlPath: 'index.html',
            // minify не указываем - oxc работает автоматически!
        }),
    ],
    build: {
        minify: 'oxc', // true или 'oxc' - oxc минифицирует ВСЁ автоматически, включая non-module скрипты!
    },
});
```

**Примечание:** Кастомная функция минификации больше не требуется для oxc!

## Особенности минификации

Плагин использует **универсальный подход** - эмитит скрипты как chunks:

- 🚀 **Автоматическая минификация** - работает с ЛЮБЫМ минификатором из коробки
- 🎯 **Эмиссия как chunks** - Rolldown/Vite обрабатывает скрипты через весь пайплайн
- 🔧 **Полная совместимость** - использует те же настройки минификации что и основной код
- ♻️ **Будущеустойчивость** - автоматически поддерживает новые минификаторы
- 🎨 **Кастомная функция** - опциональная поддержка для специальных случаев
- 🛡️ **Безопасность** - при ошибке используется оригинальный код
- 📊 **Логирование через Vite** - все сообщения через встроенный logger

### Поддержка минификаторов:

| Минификатор | Статус                    | Примечание                             |
| ----------- | ------------------------- | -------------------------------------- |
| `esbuild`   | ✅ Работает автоматически | Vite 2-6, по умолчанию                 |
| `terser`    | ✅ Работает автоматически | Vite 2-6, требует установки            |
| `oxc`       | ✅ Работает автоматически | Rolldown/Vite 7+, быстрый минификатор! |
| Будущие     | ✅ Работают автоматически | Готов к любым изменениям               |

## Пример

**До обработки (index.html):**

```html
<!DOCTYPE html>
<html>
    <head>
        <script src="/js/init-script.js"></script>
        <script src="https://cdn.example.com/external.js"></script>
        <script type="module" src="/js/module.js"></script>
    </head>
</html>
```

**После обработки в production:**

```html
<!DOCTYPE html>
<html>
    <head>
        <script src="/init-script.a1b2c3d4.js"></script>
        <script src="https://cdn.example.com/external.js"></script>
        <script type="module" src="/js/module.js"></script>
    </head>
</html>
```

## API

### `nonModuleScriptProcessor(options?)`

#### `options`

- **`htmlPath`** (string, опционально): Путь к HTML файлу относительно корня проекта. По умолчанию: `'index.html'`

- **`minify`** (boolean | MinifyFunction, опционально): Управление минификацией скриптов

    **Значения boolean:**
    - `undefined` (по умолчанию): Автоматическая минификация только в production режиме (`vite build`)
    - `true`: Принудительно включить минификацию во всех режимах
    - `false`: Отключить минификацию полностью

    **Кастомная функция:** `(code: string, config: ResolvedConfig) => Promise<string> | string`
    - Позволяет использовать любой минификатор
    - Получает код и конфигурацию Vite
    - Должна вернуть минифицированный код
    - Полезно для будущих версий Vite или специфических требований

    **При использовании boolean:**
    - Плагин эмитит скрипты как **chunks** (не assets)
    - Rolldown/Vite обрабатывает их через весь пайплайн сборки
    - Автоматически применяется минификатор из `build.minify`
    - Гарантирует идентичную минификацию как у основного кода
    - Учитывает все настройки: `build.minify`, `build.target`, `build.terserOptions`
    - **Работает с esbuild, terser, oxc и любыми будущими минификаторами**

        **Примеры:**

        ```typescript
        // Автоматическая минификация в production
        minify: undefined;

        // Принудительная минификация
        minify: true;

        // Отключить минификацию
        minify: false;

        // Кастомный минификатор (для специальных случаев)
        minify: async (code, config) => {
            const minifier = await import('custom-minifier');
            return minifier.minify(code);
        };
        ```

## Лицензия

MIT
