# vite-plugin-non-module-script-processor

Vite плагин для автоматической обработки не-модульных JavaScript скриптов.

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

Плагин автоматически находит все локальные не-модульные скрипты и:

- ✅ **В dev режиме**: скрипты работают по оригинальным путям
- ✅ **В prod режиме**: скрипты хэшируются, минифицируются и пути обновляются
- ✅ **Автоматически**: находит все `<script>` теги без `type="module"`
- ✅ **Безопасно**: игнорирует внешние CDN ссылки

## Установка

```bash
npm install @budarin/vite-plugin-non-module-script-processor
```

## Использование

```typescript
import { defineConfig } from 'vite';
import { nonModuleScriptProcessor } from '@budarin/vite-plugin-non-module-script-processor';

export default defineConfig({
    plugins: [
        nonModuleScriptProcessor({
            htmlPath: 'index.html', // опционально
        }),
    ],
});
```

**Готово!** Плагин автоматически использует встроенный минификатор Vite.

## Пример

**До обработки:**

```html
<script src="/js/init-script.js"></script>
<script src="https://cdn.example.com/external.js"></script>
<script type="module" src="/js/module.js"></script>
```

**После обработки в production:**

```html
<script src="/init-script.a1b2c3d4.js"></script>
<script src="https://cdn.example.com/external.js"></script>
<script type="module" src="/js/module.js"></script>
```

## Опции

- **`htmlPath`** (string): Путь к HTML файлу. По умолчанию: `'index.html'`
- **`minify`** (boolean): Включить/отключить минификацию. По умолчанию: `undefined` (авто)

## Лицензия

MIT
