# Документация проекта Telegram Channel Downloader

## Обзор
**Telegram Channel Downloader** — это Node.js приложение для автоматизированного скачивания сообщений и медиафайлов из Telegram каналов, групп и личных чатов. Проект использует библиотеку `gramjs` (пакет `telegram`) для взаимодействия с Telegram API.

## Архитектура системы

### Основные компоненты
1.  **Точка входа (`index.js`)**: Управляет жизненным циклом приложения, инициализирует аутентификацию и запускает процесс скачивания или валидации.
2.  **Модули (`modules/`)**:
    *   [`auth.js`](modules/auth.js): Логика авторизации, обработка OTP и управление сессиями.
    *   [`dialoges.js`](modules/dialoges.js): Работа со списком чатов (поиск, выбор, экспорт списка).
    *   [`messages.js`](modules/messages.js): Основное ядро скачивания сообщений и медиа, управление очередью загрузок и обход ограничений (Flood Wait).
3.  **Утилиты (`utils/`)**:
    *   [`helper.js`](utils/helper.js): Общие функции (логирование, работа с JSON Lines, определение типов медиа).
    *   [`file_helper.js`](utils/file_helper.js): Работа с конфигурацией (`config.json`) и состоянием (`last_selection.json`).
    *   [`input_helper.js`](utils/input_helper.js): Обертки над `inquirer` для интерактивного ввода.
    *   [`migration.js`](utils/migration.js): Скрипты для миграции данных в формат JSON Lines и дедупликации.
4.  **Валидаторы (`validators/`)**:
    *   [`index.js`](validators/index.js): CLI интерфейс для проверки целостности скачанных файлов.
    *   [`ffmpeg_validator.js`](validators/ffmpeg_validator.js): Интеграция с FFmpeg для глубокой проверки изображений и видео.
    *   [`file_scanner.js`](validators/file_scanner.js): Рекурсивный поиск медиафайлов в директории экспорта.

### Схема взаимодействия
```mermaid
graph TD
    Index[index.js] --> Auth[modules/auth.js]
    Index --> Dialogs[modules/dialoges.js]
    Index --> Messages[modules/messages.js]
    
    Messages --> Helper[utils/helper.js]
    Messages --> FileHelper[utils/file_helper.js]
    
    Auth --> Input[utils/input_helper.js]
    Auth --> FileHelper
    
    Validator[validators/index.js] --> Scanner[validators/file_scanner.js]
    Validator --> FFmpeg[validators/ffmpeg_validator.js]
```

## Процессы

### 1. Аутентификация
Пр��ложение поддерживает вход по номеру телефона с использованием OTP (через приложение Telegram или SMS). Сессия сохраняется в `config.json` в виде `sessionId` (StringSession), что позволяет избегать повторного ввода кода. Реализована защита от Flood Wait при авторизации.

### 2. Скачивание сообщений и медиа
*   **Пакетная обработка**: Сообщения запрашиваются пачками (по умолчанию 200 штук).
*   **Параллельная загрузка**: Медиафайлы скачиваются параллельно с использованием динамически регулируемого лимита (по умолчанию до 20 потоков).
*   **Flood Control**: Система автоматически снижает количество параллельных загрузок и делает паузы при получении ошибок `FLOOD_WAIT` от Telegram API.
*   **Кэширование**: Перед скачиванием проверяется наличие файла на диске и его размер, чтобы избежать повторных загрузок.

### 3. Валидация файлов
Инструмент валидации позволяет:
*   Сканировать папку `export/` на наличие поврежденных файлов.
*   Использовать FFmpeg для проверки того, что видео и изображения открываются корректно.
*   Автоматически удалять битые файлы (режим `--dry-run` позволяет только просмотреть список).

## Форматы данных

### JSON Lines
Для хранения сообщений используется формат **JSON Lines** (`.json`). Каждая строка файла является валидным JSON-объектом (или массивом объектов).
*   `raw_message.json`: Полные данные от Telegram API.
*   `all_message.json`: Упрощенная структура для быстрого доступа.

**Преимущества:**
*   Дозапись в конец файла за O(1).
*   Низкое потребление памяти при чтении больших файлов.
*   Устойчивость к повреждению файла (битая строка не портит весь файл).

### Структура экспорта
```text
export/
├── [channel_id]/
│   ├── all_message.json
│   ├── raw_message.json
│   ├── image/
│   ├── video/
│   ├── audio/
│   └── ... (другие типы медиа)
├── dialog_list.json
├── dialog_list.html
└── last_selection.json
```

## Настройка и запуск
1.  Создать `config.json` с `apiId` и `apiHash`.
2.  `npm install` — установка зависимостей.
3.  `npm start` — запуск основного процесса.
4.  `npm run valid` — запуск валидатора.
5.  `npm run migrate` — конвертация старых JSON-файлов в формат JSON Lines.

## Технологический стек
*   **Runtime**: Node.js
*   **API**: GramJS (Telegram)
*   **UI**: Inquirer (CLI), EJS (HTML Export)
*   **Validation**: FFmpeg / FFprobe
