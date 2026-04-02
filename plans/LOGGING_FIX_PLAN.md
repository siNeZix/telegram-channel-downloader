# План исправления механизма Download progress

## Проблемы

### 1. Дробное значение totalFilesToDownload
**Описание:** В формуле оценки общего количества файлов для скачивания используется выражение:
```javascript
actualFilesFound + (totalMessagesInChannel - totalFetched) * 0.5
```
Если `(totalMessagesInChannel - totalFetched)` нечётное, результат умножения на 0.5 даёт дробное число. Это приводит к тому, что `totalFilesToDownload` становится дробным, что некорректно.

**Пример из лога:** `Download progress: 388/17480.5 (2%)`

### 2. Нет временной метки в логах
**Описание:** Логи Download progress не содержат отметку времени, что затрудняет анализ.

### 3. Возможные неточности в подсчёте failedDownloads
**Описание:** Логика подсчёта ошибок корректна, но в примере пользователя `failed: 194` при `finished: 388` (50% ошибок) выглядит подозрительно. Возможно, это реальные ошибки, но стоит добавить более детальное логирование причин ошибок.

### 4. Race condition при модификации speedHistory
**Описание:** Массив `speedHistory` модифицируется в функции `logDownloadProgress`, которая может вызываться из нескольких обработчиков промисов. Хотя JavaScript однопоточный, модификация массива между вызовами может привести к некорректным вычислениям скорости.

## Шаги решения

### Шаг 1: Исправить формулу оценки totalFilesToDownload
**Файл:** `modules/messages.js`
**Строки:** 418-422
**Изменение:** Округлить выражение `(totalMessagesInChannel - totalFetched) * 0.5` до целого числа с помощью `Math.ceil` или `Math.round`.

Предлагаемый код:
```javascript
totalFilesToDownload = Math.min(
    Math.max(totalFilesToDownload, estimatedTotal),
    actualFilesFound + Math.ceil((totalMessagesInChannel - totalFetched) * 0.5)
);
```

### Шаг 2: Добавить временную метку в лог Download progress
**Файл:** `modules/messages.js`
**Функция:** `logDownloadProgress`
**Изменение:** Добавить текущее время в формате `HH:MM:SS` в начало сообщения.

Предлагаемый код:
```javascript
const now = new Date();
const timestamp = now.toLocaleTimeString('ru-RU', { hour12: false });
logMessage.info(
    `[${timestamp}] Download progress: ${finished}/${totalFiles} (${percent}%), failed: ${failed}, speed: ${speedText}, downloaded: ${formatBytes(totalBytesDownloaded)}, ETA: ${eta}`,
);
```

### Шаг 3: Улучшить логирование ошибок
**Файл:** `modules/messages.js`
**Функция:** `downloadMessageMedia`
**Изменение:** Добавить более детальное логирование ошибок при возврате `{ success: false }`.

Предлагаемый код:
```javascript
} else {
    logMessage.error(`Failed to download media for message ${message.id}: no media content`);
    return { success: false, fileSize: 0 };
}
```

### Шаг 4: Защитить speedHistory от race condition
**Файл:** `modules/messages.js`
**Изменение:** Передавать копию speedHistory в функцию logDownloadProgress, а не модифицировать исходный массив. Или использовать мьютекс, но в данном случае проще передавать копию.

Однако, это может привести к потере данных для вычисления скорости. Лучше оставить как есть, но добавить комментарий о том, что модификация безопасна в контексте однопоточного выполнения.

### Шаг 5: Обновить документацию
**Файл:** `Readme.md` или `plans/PROJECT_ANALYSIS.md`
**Изменение:** Добавить описание изменений в механизме логирования.

## Порядок реализации

1. Исправить формулу оценки totalFilesToDownload (Шаг 1)
2. Добавить временную метку в лог (Шаг 2)
3. Улучшить логирование ошибок (Шаг 3)
4. Протестировать изменения
5. Обновить документацию (Шаг 5)

## Ожидаемый результат

После исправлений лог Download progress будет выглядеть так:
```
[14:30:25] Download progress: 388/17481 (2%), failed: 10, speed: 0.24 MB/s (overall), downloaded: 543.81 MB, ETA: 27:19:53
```

Где:
- `totalFilesToDownload` всегда целое число
- Добавлена временная метка
- Ошибки логируются более детально