import { defineMessages } from '../define';

const one = (v: Record<string, string | number>, key = 'count') => Number(v[key]) === 1;

export default defineMessages({
  en: {
    'style.title': 'Style',
    'style.description': 'Adjust how transcripts are written and formatted.',
    'style.tab.dictionary': 'Dictionary',
    'style.tab.replacements': 'Replacements',
    'style.tab.learned': 'Learned Words',
    'style.tab.instructions': 'Custom Instructions',

    'style.add': 'Add',
    'style.delete': 'Delete',
    'style.close': 'Close',
    'style.undo': 'Undo',
    /** Undoes something the app learned */
    'style.forget': 'Forget',
    /** {example} is Japanese text, shown as it is in both languages */
    'style.example': 'Example: {example}',
    'style.noMatchingWords': 'No matching words',
    /** How many times something was seen */
    'style.times': (v) => (one(v) ? '1 time' : '{count} times'),

    'style.dictionary.title': 'Dictionary ({count} / {max} words)',
    'style.dictionary.description':
      'Words you want transcribed correctly, such as names of people, companies and products, and technical terms. Used both as vocabulary hints for speech recognition and for formatting by the LLM. Separate words with commas to add several at once. Click a word to set the readings used for matching.',
    'style.dictionary.findHint': 'Find candidate words for the dictionary in your history or your own documents',
    'style.dictionary.import': 'Import…',
    'style.dictionary.importHint': 'Import a text file with one word per line, or JSON',
    'style.dictionary.export': 'Export',
    'style.dictionary.full': 'The limit of {max} words has been reached. Remove words you do not use.',
    'style.dictionary.search': 'Search the dictionary',
    'style.dictionary.setReadings': 'Set readings',
    /** Tag on a word that has readings */
    'style.dictionary.hasReadings': 'readings',
    'style.dictionary.removed': 'Removed “{word}”',
    'style.dictionary.importEmpty': 'Could not read any words from the file. Choose a text file with one word per line, or a JSON array of words.',
    'style.dictionary.added': (v) => (one(v) ? 'Added 1 word.' : 'Added {count} words.'),
    /** {reasons} is a list of style.dictionary.reason.* */
    'style.dictionary.notAdded': 'Not added: {reasons}.',
    'style.dictionary.someNotAdded': (v) => (one(v) ? 'Added 1 word. Not added: {reasons}.' : 'Added {count} words. Not added: {reasons}.'),
    'style.dictionary.reason.overLimit': (v) => (one(v) ? '1 word over the limit of {limit} words' : '{count} words over the limit of {limit} words'),
    'style.dictionary.reason.tooLong': (v) => (one(v) ? '1 word longer than {max} characters' : '{count} words longer than {max} characters'),
    'style.dictionary.reason.duplicate': (v) => (one(v) ? '1 word already in the dictionary' : '{count} words already in the dictionary'),

    'style.readings.title': 'Readings of “{word}”',
    'style.readings.description':
      'Used for matching when speech recognition writes this word in kana. Text that matches a reading written here is replaced with this word, even when the LLM is not used.',
    'style.readings.kanaOnly': 'Write readings in hiragana or katakana.',
    'style.readings.suggested': 'Suggested readings (made by the LLM, not checked):',
    'style.readings.accept': 'Use this reading',

    'style.candidates.find': 'Find Candidates',
    'style.candidates.fromHistory': 'From Longhand History',
    'style.candidates.fromFiles': 'From Files…',
    'style.candidates.fromFilesHint': 'Meeting notes, memos, history exported by other apps and so on. You can choose text or JSON files',
    'style.candidates.description':
      'Lists words in Latin letters (product names and technical terms) that appear in the text and are not in the dictionary yet, most frequent first. Everything is processed on this Mac.',
    'style.candidates.historyError': 'Could not read the history.',
    'style.candidates.fileError': 'Could not read the file.',
    /** Where candidates came from; fills {source} */
    'style.candidates.source.history': (v) => (one(v) ? '1 history item' : '{count} history items'),
    'style.candidates.source.files': '{count} files',
    'style.candidates.allAdded': 'All candidates have been added.',
    'style.candidates.none': 'No words in Latin letters missing from the dictionary were found in {source}.',
    'style.candidates.count': (v) => (one(v) ? '1 word from {source}' : '{count} words from {source}'),
    'style.candidates.selectAll': 'Select All',
    'style.candidates.deselectAll': 'Deselect All',
    'style.candidates.addSelected': (v) => (one(v) ? 'Add 1 Selected Word to Dictionary' : 'Add {count} Selected Words to Dictionary'),

    'style.replacements.title': 'Replacements ({count})',
    'style.replacements.description':
      'Replaces set words with set text after formatting (email addresses, URLs, boilerplate and so on). It does not go through the LLM, so the result is always the same. Matching ignores case and full-width/half-width differences.',
    'style.replacements.add': '+ Add',
    'style.replacements.search': 'Search replacements',
    'style.replacements.empty': 'No replacements yet',
    'style.replacements.noMatch': 'No matching replacements',
    'style.replacements.removed': 'Removed the replacement “{word}”',
    /** {example} is Japanese text, shown as it is in both languages */
    'style.replacements.fromPlaceholder': 'Spoken words (example: {example})',
    'style.replacements.toPlaceholder': 'Text to type',
    'style.replacements.preserveCase': 'Keep the capitalization of the replacement',
    'style.replacements.preserveCaseHint': 'When off, a lowercase first letter is capitalized at the start of a sentence',
    'style.replacements.noPunctuation': 'Do not add punctuation right after it',
    'style.replacements.duplicate': 'A replacement for the same words already exists. It was not saved.',
    'style.replacements.emptyFrom': 'Enter the spoken words. Nothing is replaced while they are empty.',
    'style.replacements.oneChar': 'Words of a single character also replace text in places you did not intend.',
    'style.replacements.overlap': 'Overlaps with the replacement for “{other}”. When both match the same place, the longer one takes priority.',
    'style.replacements.tooManyWords': 'Four or more words stop matching when the transcript is written even slightly differently. Use shorter words.',
    'style.replacements.trailingNewline': 'The replacement ends with a line break. A new line starts after the text is typed.',
    'style.replacements.tooLong': 'Replacements can be up to {max} characters. Anything beyond that is not saved.',

    'style.blocked.title': 'Words Not to Learn ({count})',
    'style.blocked.description': 'Words here are never learned automatically from your corrections. Learned words you forget are added here too.',
    'style.blocked.placeholder': 'Words not to learn (separate with commas to add several)',
    'style.blocked.remove': 'Remove from words not to learn',

    'style.learned.sectionTitle': 'Learning from Corrections',
    'style.learned.sectionDescription':
      'When you correct the typed text by hand right after dictating, the corrected words are added to the dictionary. Corrections that do not go into the dictionary (a different word with the same reading, notation, undoing a rewrite by formatting) are remembered as ways you correct text. The differences are found on this Mac, and only the corrected words and a short piece of the text around them are sent to the LLM to decide whether they belong in the dictionary.',
    'style.learned.enable': 'Learn from corrections',
    'style.learned.enableHint': (v) =>
      one(v, 'seconds')
        ? 'Watches the text field for 1 second after typing. Not in password fields or terminals.'
        : 'Watches the text field for {seconds} seconds after typing. Not in password fields or terminals.',
    'style.learned.title': 'Learned Words ({count} / {max} words)',
    'style.learned.description':
      'Beyond the limit, the words learned earliest are removed first. When a single correction changes more than 3 words, it is treated as a rewrite and nothing is learned.',
    'style.learned.search': 'Search learned words',
    'style.learned.empty': 'None yet',
    'style.learned.moveToDictionary': 'Move to Dictionary',
    'style.learned.dictionaryFull': 'Cannot move it, because the dictionary has reached its limit of {max} words.',
    'style.learned.forgotten': 'Forgot “{word}”',

    'style.misheard.title': 'Misheard Forms of Dictionary Words',
    'style.misheard.description':
      'When you correct something to a word in the dictionary, the form before the correction is remembered. The next time the same form appears, it is treated as a candidate for that word.',
    'style.misheard.remove': 'Remove this form',

    'style.corrections.title': 'Corrected Mix-Ups ({count})',
    'style.corrections.description':
      'Remembers corrections to a different word with the same reading and corrections of notation. They are not added to the dictionary; the next time the form on the left appears, it is changed to the form on the right if it fits the context (when the LLM is used).',

    'style.kept.title': 'Phrases to Keep ({count})',
    'style.kept.description': 'When you change text that formatting rewrote back to what you said, the phrase is remembered and is not rewritten from then on.',
    'style.kept.notTo': '(not “{text}”)',

    'style.numbers.title': 'Number Notation',
    /** {from} and {to} are Japanese examples, shown as they are in both languages */
    'style.numbers.description':
      'When you correct only how a number is written (changing “{from}” to “{to}”, for example), that notation is remembered. From then on, text is typed in that notation, even when the LLM is not used. Terminals and code editors are left as they are.',
    /** {example} in the style.numbers.* values is Japanese text the app writes, shown as it is in both languages */
    'style.numbers.width.title': 'Digit width',
    'style.numbers.width.half': 'Half-width ({example})',
    'style.numbers.width.full': 'Full-width ({example})',
    'style.numbers.grouping.title': 'Thousands separator',
    'style.numbers.grouping.comma': 'On ({example})',
    'style.numbers.grouping.none': 'Off ({example})',
    /** {man} and {oku} are the Japanese units for 10,000 and 100,000,000 */
    'style.numbers.units.title': '{man} and {oku}',
    'style.numbers.units.kanji': 'Use ({example})',
    'style.numbers.units.digits': 'Do not use ({example})',
    'style.numbers.counters.title': 'Counters',
    'style.numbers.counters.kanji': 'Kanji numerals ({example})',
    'style.numbers.counters.digits': 'Arabic numerals ({example})',
    'style.numbers.percent.title': 'Percent',
    'style.numbers.percent.symbol': 'Symbol ({example})',
    'style.numbers.percent.word': 'Katakana ({example})',
    'style.numbers.time.title': 'Time',
    'style.numbers.date.title': 'Date',

    'style.instructions.title': 'Custom Instructions',
    /** {a}, {b} and {c} are example instructions in Japanese, shown as they are in both languages */
    'style.instructions.description': 'Extra instructions given to the LLM when formatting. Saved 1 second after you stop typing. Examples: “{a}”, “{b}”, “{c}”.',
    'style.instructions.placeholder': 'Instructions written here take priority over the formatting rules.',
    'style.instructions.long': 'Long instructions slow down responses',
    'style.instructions.saved': 'Saved',
    'style.instructions.length': (v) => (one(v) ? '1 character' : '{count} characters'),
  },
  ja: {
    'style.title': 'スタイル',
    'style.description': '書き起こしの表記と整形のしかたを調整します。',
    'style.tab.dictionary': '辞書',
    'style.tab.replacements': '置換',
    'style.tab.learned': '学習した語',
    'style.tab.instructions': 'カスタム指示',

    'style.add': '追加',
    'style.delete': '削除',
    'style.close': '閉じる',
    'style.undo': '元に戻す',
    'style.forget': '取り消す',
    'style.example': '例: {example}',
    'style.noMatchingWords': '一致する語はありません',
    'style.times': '{count} 回',

    'style.dictionary.title': '辞書（{count} / {max} 語）',
    'style.dictionary.description':
      '人名、社名、製品名、専門用語など、正しく書き起こしてほしい語。音声認識の語彙ヒントと LLM の整形の両方に使います。カンマ区切りでまとめて追加できます。語を押すと、照合に使う読みを設定できます。',
    'style.dictionary.findHint': '履歴や手元の文書から、辞書に入れる語の候補を探します',
    'style.dictionary.import': '読み込む',
    'style.dictionary.importHint': '1 行に 1 語のテキストか JSON を読み込みます',
    'style.dictionary.export': '書き出す',
    'style.dictionary.full': '上限の {max} 語に達しています。使わない語を削除してください。',
    'style.dictionary.search': '辞書の語を探す',
    'style.dictionary.setReadings': '読みを設定する',
    'style.dictionary.hasReadings': '読み',
    'style.dictionary.removed': '「{word}」を削除しました',
    'style.dictionary.importEmpty': 'ファイルから語を読み取れませんでした。1 行に 1 語のテキストか、語の配列の JSON を選んでください。',
    'style.dictionary.added': '{count} 語を追加しました。',
    'style.dictionary.notAdded': '{reasons}は追加していません。',
    'style.dictionary.someNotAdded': '{count} 語を追加しました。{reasons}は追加していません。',
    'style.dictionary.reason.overLimit': '上限の {limit} 語に達したため {count} 語',
    'style.dictionary.reason.tooLong': '{max} 字を超える {count} 語',
    'style.dictionary.reason.duplicate': '登録済みの {count} 語',

    'style.readings.title': '「{word}」の読み',
    'style.readings.description': '音声認識がこの語をかなで書いたときに照合します。ここに書いた読みと一致したところは、LLM を使わない設定でもこの語に置き換えます。',
    'style.readings.kanaOnly': '読みはひらがなかカタカナで書いてください。',
    'style.readings.suggested': '読みの候補（LLM が作成、未確認）:',
    'style.readings.accept': 'この読みを採用する',

    'style.candidates.find': '候補を探す',
    'style.candidates.fromHistory': 'Longhand の履歴から',
    'style.candidates.fromFiles': 'ファイルから…',
    'style.candidates.fromFilesHint': '議事録やメモ、ほかのアプリが書き出した履歴など。テキストか JSON を選べます',
    'style.candidates.description': '文章に出てくる英字の語（製品名や技術用語）のうち、まだ辞書にない語を、出てきた回数の多い順に並べます。処理はこの Mac の中だけで行います。',
    'style.candidates.historyError': '履歴を読めませんでした。',
    'style.candidates.fileError': 'ファイルを読めませんでした。',
    'style.candidates.source.history': '履歴の {count} 件',
    'style.candidates.source.files': '{count} 個のファイル',
    'style.candidates.allAdded': '候補はすべて追加しました。',
    'style.candidates.none': '{source}には、辞書にない英字の語が見つかりませんでした。',
    'style.candidates.count': '{source}から {count} 語',
    'style.candidates.selectAll': 'すべて選ぶ',
    'style.candidates.deselectAll': 'すべて外す',
    'style.candidates.addSelected': '選んだ {count} 語を辞書に追加',

    'style.replacements.title': '置換（{count} 件）',
    'style.replacements.description':
      '整形の後に、決まった言葉を決まった文字列に置き換えます（メールアドレス、URL、定型文など）。LLM を通さないので、毎回必ず同じ結果になります。一致は大文字小文字と全角半角を区別しません。',
    'style.replacements.add': '＋ 追加',
    'style.replacements.search': '置換を探す',
    'style.replacements.empty': '置換はまだありません',
    'style.replacements.noMatch': '一致する置換はありません',
    'style.replacements.removed': '「{word}」の置換を削除しました',
    'style.replacements.fromPlaceholder': '話した言葉（例: {example}）',
    'style.replacements.toPlaceholder': '入力する文字列',
    'style.replacements.preserveCase': '置換後の大文字小文字をそのまま使う',
    'style.replacements.preserveCaseHint': 'オフにすると、文頭では先頭の英小文字を大文字にします',
    'style.replacements.noPunctuation': '直後の句読点を付けない',
    'style.replacements.duplicate': '同じ言葉の置換がすでにあります。保存していません。',
    'style.replacements.emptyFrom': '話した言葉を入れてください。空のままでは置き換えません。',
    'style.replacements.oneChar': '1 字だけの言葉は、意図しない箇所も置き換わります。',
    'style.replacements.overlap': '「{other}」の置換と重なります。同じ箇所に一致したときは、長いほうが優先されます。',
    'style.replacements.tooManyWords': '4 語以上の言葉は、書き起こしの表記が少し違うだけで一致しなくなります。短い言葉にしてください。',
    'style.replacements.trailingNewline': '置換後の末尾に改行があります。入力の後で改行されます。',
    'style.replacements.tooLong': '置換後は {max} 字までです。超えた分は保存しません。',

    'style.blocked.title': '学習しない語（{count} 語）',
    'style.blocked.description': 'ここにある語は、手直しから自動で学習しません。取り消した学習語もここに入ります。',
    'style.blocked.placeholder': '学習させたくない語（カンマ区切りでまとめて追加）',
    'style.blocked.remove': '学習しない語から外す',

    'style.learned.sectionTitle': '手直しからの学習',
    'style.learned.sectionDescription':
      '音声入力の直後に、入力された文をあなたが手で直すと、直した語を辞書に追加します。辞書に入れない直し（同じ読みの別の語、表記、整形の書き換えを戻したもの）も、直し方として覚えます。差分は端末内で取り出し、LLM には直した語と前後の短い文だけを送って、辞書に入れるべき語かを判定させます。',
    'style.learned.enable': '手直しから学習する',
    'style.learned.enableHint': '入力後 {seconds} 秒間、入力欄の変化を見ます。パスワード欄とターミナルでは見ません。',
    'style.learned.title': '学習した語（{count} / {max} 語）',
    'style.learned.description': '上限を超えると、古く学習した語から外れます。1 回の手直しで 3 語より多く直したときは、書き直しとみなして学習しません。',
    'style.learned.search': '学習した語を探す',
    'style.learned.empty': 'まだありません',
    'style.learned.moveToDictionary': '辞書に移す',
    'style.learned.dictionaryFull': '辞書が上限の {max} 語に達しているため、移せません。',
    'style.learned.forgotten': '「{word}」の学習を取り消しました',

    'style.misheard.title': '辞書の語の聞き違えた形',
    'style.misheard.description': '辞書にある語に直したとき、直す前の形を覚えます。次に同じ形が出たら、その語の候補として扱います。',
    'style.misheard.remove': 'この形を外す',

    'style.corrections.title': '直した取り違え（{count} 件）',
    'style.corrections.description': '同じ読みの別の語や、表記の直しを覚えます。辞書には入れず、次に左の形が出たときに、文脈に合えば右の形に直します（LLM を使うとき）。',

    'style.kept.title': '書き換えない語句（{count} 件）',
    'style.kept.description': '整形が書き換えた所を、あなたが話したとおりに戻したとき、その語句を覚えます。次からは書き換えません。',
    'style.kept.notTo': '（「{text}」にしない）',

    'style.numbers.title': '数字の書き方',
    'style.numbers.description':
      '数字の書き方だけを直したとき（「{from}」を「{to}」にした、など）、その書き方を覚えます。次からは、LLM を使わないときも、この書き方で入力します。ターミナルとコードエディタでは変えません。',
    'style.numbers.width.title': '数字の幅',
    'style.numbers.width.half': '半角（{example}）',
    'style.numbers.width.full': '全角（{example}）',
    'style.numbers.grouping.title': '3 桁の区切り',
    'style.numbers.grouping.comma': '入れる（{example}）',
    'style.numbers.grouping.none': '入れない（{example}）',
    'style.numbers.units.title': '{man}と{oku}',
    'style.numbers.units.kanji': '使う（{example}）',
    'style.numbers.units.digits': '使わない（{example}）',
    'style.numbers.counters.title': '数え方',
    'style.numbers.counters.kanji': '漢数字（{example}）',
    'style.numbers.counters.digits': '算用数字（{example}）',
    'style.numbers.percent.title': '百分率',
    'style.numbers.percent.symbol': '記号（{example}）',
    'style.numbers.percent.word': 'カタカナ（{example}）',
    'style.numbers.time.title': '時刻',
    'style.numbers.date.title': '日付',

    'style.instructions.title': 'カスタム指示',
    'style.instructions.description': '整形のときに LLM へ追加で伝える指示です。入力が止まって 1 秒たつと保存します。例:「{a}」「{b}」「{c}」。',
    'style.instructions.placeholder': 'ここに書いた指示は、整形の規則より優先されます。',
    'style.instructions.long': '長い指示は応答を遅くします',
    'style.instructions.saved': '保存しました',
    'style.instructions.length': '{count} 字',
  },
});
