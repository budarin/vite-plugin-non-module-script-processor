# vite-plugin-non-module-script-processor

Vite плагин для автоматической обработки не-модульных JavaScript скриптов.

## Проблема

Vite по умолчанию **не обрабатывает** обычные JavaScript скрипты (не модули) в HTML файлах. Это означает, что:

- ❌ Скрипты не хэшируются в production сборке
- ❌ Пути к скриптам не обновляются автоматически
- ❌ Скрипты не проходят через Vite pipeline для оптимизации
- ❌ Нет поддержки hot reload для обычных скриптов

## Решение

Этот плагин автоматически находит все локальные не-модульные скрипты в HTML и:

- ✅ **В dev режиме**: скрипты доступны по оригинальным путям
- ✅ **В prod режиме**: скрипты хэшируются и пути в HTML автоматически обновляются
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

## Использование

```typescript
import { defineConfig } from 'vite';
import { nonModuleScriptProcessor } from '@budarin/vite-plugin-non-module-script-processor';

export default defineConfig({
    plugins: [
        nonModuleScriptProcessor({
            htmlPath: 'index.html', // опционально, по умолчанию 'index.html'
        }),
    ],
});
```

## Пример

**До обработки (index.html):**

```html
<!DOCTYPE html>
<html>
    <head>
        <script src="/js/legacy-script.js"></script>
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
        <script src="/legacy-script.a1b2c3d4.js"></script>
        <script src="https://cdn.example.com/external.js"></script>
        <script type="module" src="/js/module.js"></script>
    </head>
</html>
```

## API

### `nonModuleScriptProcessor(options?)`

#### `options`

- **`htmlPath`** (string, опционально): Путь к HTML файлу относительно корня проекта. По умолчанию: `'index.html'`

## Лицензия

MIT
