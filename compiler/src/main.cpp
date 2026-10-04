#include <iostream>
#include <string>
#include <vector>
#include <optional>
#include <cctype>
#include <stdexcept>
#include <utility>

namespace aura {
namespace lexer {

enum class TokenKind {
    Identifier,
    Number,
    Keyword,
    Operator,
    Punctuation,
    String,
    EndOfFile
};

struct Token {
    TokenKind kind{};
    std::string text;
    std::string sourceFile;
    std::size_t line = 1;
    std::size_t column = 1;
    std::size_t offset = 0;
    std::size_t length = 0;
};

class Lexer {
public:
    explicit Lexer(std::string input, std::string sourceFile = "<memory>") : input_(std::move(input)), sourceFile_(std::move(sourceFile)) {}

    std::vector<Token> tokenize() {
        std::vector<Token> tokens;
        while (!eof()) {
            if (std::isspace(static_cast<unsigned char>(peek()))) {
                advance();
                continue;
            }

            const auto start = cursor_;
            const auto ch = peek();
            if (std::isalpha(static_cast<unsigned char>(ch)) || ch == '_') {
                advance();
                while (!eof() && (std::isalnum(static_cast<unsigned char>(peek())) || peek() == '_')) {
                    advance();
                }
                const auto text = input_.substr(start, cursor_ - start);
                tokens.push_back(Token{TokenKind::Identifier, text, sourceFile_, line_, column_ - (cursor_ - start), start, cursor_ - start});
                continue;
            }

            if (std::isdigit(static_cast<unsigned char>(ch))) {
                advance();
                while (!eof() && std::isdigit(static_cast<unsigned char>(peek()))) {
                    advance();
                }
                const auto text = input_.substr(start, cursor_ - start);
                tokens.push_back(Token{TokenKind::Number, text, sourceFile_, line_, column_ - (cursor_ - start), start, cursor_ - start});
                continue;
            }

            if (ch == '"') {
                advance();
                while (!eof() && peek() != '"') {
                    advance();
                }
                if (eof()) {
                    throw std::runtime_error("unterminated string literal");
                }
                advance();
                const auto text = input_.substr(start + 1, cursor_ - start - 2);
                tokens.push_back(Token{TokenKind::String, text, sourceFile_, line_, column_ - (cursor_ - start), start, cursor_ - start});
                continue;
            }

            if (ch == ';' || ch == '{' || ch == '}' || ch == '(' || ch == ')' || ch == '[' || ch == ']') {
                advance();
                const auto text = input_.substr(start, 1);
                tokens.push_back(Token{TokenKind::Punctuation, text, sourceFile_, line_, column_ - 1, start, 1});
                continue;
            }

            if (ch == '+' || ch == '-' || ch == '*' || ch == '/' || ch == '=' || ch == ':' || ch == '!') {
                advance();
                const auto text = input_.substr(start, 1);
                tokens.push_back(Token{TokenKind::Operator, text, sourceFile_, line_, column_ - 1, start, 1});
                continue;
            }

            throw std::runtime_error("malformed token at position " + std::to_string(start));
        }

        tokens.push_back(Token{TokenKind::EndOfFile, "", sourceFile_, line_, column_, cursor_, 0});
        return tokens;
    }

private:
    char peek() const {
        if (eof()) {
            return '\0';
        }
        return input_[cursor_];
    }

    char advance() {
        const auto ch = input_[cursor_++];
        if (ch == '\n') {
            ++line_;
            column_ = 1;
        } else {
            ++column_;
        }
        return ch;
    }

    bool eof() const { return cursor_ >= input_.size(); }

    std::string input_;
    std::string sourceFile_;
    std::size_t cursor_ = 0;
    std::size_t line_ = 1;
    std::size_t column_ = 1;
};

}  // namespace lexer

namespace ast {
struct Node {
    std::string kind;
    std::size_t line = 1;
    std::size_t column = 1;
};

struct Module : Node {
    std::string name;
    std::vector<std::string> ports;
};
}  // namespace ast

namespace parser {
class Parser {
public:
    explicit Parser(std::vector<lexer::Token> tokens) : tokens_(std::move(tokens)) {}

    ast::Module parseModule() {
        const auto token = match(lexer::TokenKind::Identifier, "module");
        if (!token.has_value()) {
            throw std::runtime_error("expected module keyword");
        }
        const auto name = match(lexer::TokenKind::Identifier);
        if (!name.has_value()) {
            throw std::runtime_error("expected module name");
        }

        ast::Module module;
        module.kind = "Module";
        module.name = name->text;
        module.line = name->line;
        module.column = name->column;
        return module;
    }

private:
    std::optional<lexer::Token> match(lexer::TokenKind kind, const std::string& text = {}) {
        if (cursor_ >= tokens_.size()) {
            return std::nullopt;
        }

        const auto& token = tokens_[cursor_];
        if (token.kind != kind) {
            return std::nullopt;
        }
        if (!text.empty() && token.text != text) {
            return std::nullopt;
        }
        ++cursor_;
        return token;
    }

    std::vector<lexer::Token> tokens_;
    std::size_t cursor_ = 0;
};
}  // namespace parser

}  // namespace aura

int main() {
    const std::string source = "module top();\nendmodule\n";

    aura::lexer::Lexer lexer(source, "top.sv");
    const auto tokens = lexer.tokenize();

    for (const auto& token : tokens) {
        std::cout << "kind=" << static_cast<int>(token.kind) << " text=" << token.text << "\n";
    }

    aura::parser::Parser parser(tokens);
    const auto module = parser.parseModule();
    std::cout << "parsed module: " << module.name << "\n";
    return 0;
}
