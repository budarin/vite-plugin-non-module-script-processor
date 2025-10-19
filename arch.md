# Архитектура плагина non-module-script-processor

## Задача плагина

Плагин должен обработать non-module JavaScript скрипты, которые не обрабатываются Vite/Rolldown автоматически. Для каждого такого скрипта нужно:

1. Минифицировать код
2. Добавить хэш к имени файла для кэширования
3. Поместить файл в папку `assets/`
4. Обновить путь к файлу в HTML

## Ключевое решение: использовать Chunks вместо Assets

Изначально мы пытались эмитить файлы как Assets, но столкнулись с проблемой: **Assets - это статические файлы, к которым Rolldown/Vite не применяет минификацию и трансформации**.

Правильное решение - эмитить файлы как **Chunks**. Chunk - это модуль кода, который проходит через весь пайплайн обработки Vite/Rolldown: минификация, хэширование, трансформации.

**Главное преимущество:** Rolldown автоматически применит тот минификатор, который настроен в `build.minify` (esbuild, terser, oxc или любой будущий). Мы не зависим от конкретных реализаций.

## Реализация в плагине

### Шаг 1: Создаём виртуальные модули

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
        // Читаем и возвращаем содержимое
        return readFileSync(scriptPath, 'utf-8');
    }
    return null;
}
```

Префикс `\0` - это соглашение Rollup/Rolldown для виртуальных модулей. Он указывает, что это внутренний модуль, который не должен создавать файл на диске.

### Шаг 2: Эмитим chunks в buildStart

В хуке `buildStart` мы проходим по всем найденным non-module скриптам и эмитим их как chunks:

```typescript
buildStart() {
    const foundScripts = findNonModuleScripts(); // Находим скрипты в HTML

    for (const script of foundScripts) {
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
    }
}
```

**Важные моменты:**

- `emitFile` с `type: 'chunk'` можно вызывать только в ранних хуках (buildStart, resolveId, load, transform, moduleParsed)
- В параметре `name` указываем имя БЕЗ расширения `.js` - Rolldown добавит его сам
- НЕ указываем `fileName` - Rolldown автоматически добавит хэш и поместит в `assets/`
- Сохраняем `chunkId` для последующего получения финального имени файла

### Шаг 3: Rolldown обрабатывает chunks

После вызова `emitFile` Rolldown:

1. Резолвит виртуальный модуль через наш хук `resolveId`
2. Загружает код через наш хук `load`
3. Обрабатывает код через пайплайн (минификация, трансформации)
4. Генерирует финальный файл с хэшем в папке `assets/`

Мы ничего не делаем на этом этапе - всё происходит автоматически.

### Шаг 4: Получаем финальные имена файлов в generateBundle

В хуке `generateBundle` chunks уже сгенерированы, и мы можем получить их финальные имена:

```typescript
async generateBundle() {
    // Получаем финальные имена для всех chunks
    for (const script of nonModuleScripts) {
        const chunkId = chunkIds.get(script.originalPath);
        if (chunkId) {
            // ЗДЕСЬ можем вызвать getFileName - chunks уже готовы
            script.hashedFileName = this.getFileName(chunkId);
            // Результат: "assets/splash-a1b2c3d4.js"
        }
    }
}
```

**Критично важно:** `getFileName()` можно вызывать только после генерации chunks:

- ✅ В `generateBundle` - chunks готовы
- ✅ В `writeBundle` - chunks готовы
- ❌ В `buildStart` - chunks ещё не созданы, будет ошибка
- ❌ В `renderStart` - chunks ещё не сгенерированы, будет ошибка

### Шаг 5: Обновляем пути в HTML

В хуке `closeBundle` обновляем пути к скриптам в HTML:

```typescript
closeBundle() {
    const htmlPath = path.resolve(process.cwd(), 'dist', 'index.html');
    let htmlContent = readFileSync(htmlPath, 'utf-8');

    // Заменяем старые пути на новые с хэшами
    for (const script of nonModuleScripts) {
        htmlContent = htmlContent.replace(
            `src="${script.originalPath}"`,
            `src="/${script.hashedFileName}"`
        );
    }

    writeFileSync(htmlPath, htmlContent);
}
```

## Порядок выполнения хуков

Понимание порядка выполнения хуков критично для правильной работы плагина:

```
1. configResolved
   → Сохраняем config для логирования

2. buildStart
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

7. closeBundle
   → Обновляем HTML с новыми путями
```

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

- ✅ Автоматическая минификация любым настроенным минификатором
- ✅ Автоматическое хэширование файлов
- ✅ Правильное размещение в папке `assets/`
- ✅ Уважение к настройкам `build.target` и `build.minify`
- ✅ Полная совместимость с текущими и будущими версиями Vite/Rolldown
- ✅ Нет зависимостей от конкретных реализаций минификаторов
