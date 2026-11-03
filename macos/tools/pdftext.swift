import Foundation
import PDFKit

// Prints a PDF's text using PDFKit, whose word spacing is reliable where
// pypdf often glues words together ("anunintended") or splits them
// ("V A"). app.py keeps pypdf's layout for lines and columns and uses these
// words only to repair spacing. Bundled in Apply Desk.app as
// Contents/MacOS/pdftext and called by the local service.
// Usage: pdftext <file.pdf>

guard CommandLine.arguments.count > 1, let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else {
    FileHandle.standardError.write(Data("usage: pdftext <file.pdf>\n".utf8))
    exit(1)
}
for index in 0..<document.pageCount {
    print(document.page(at: index)?.string ?? "")
}
