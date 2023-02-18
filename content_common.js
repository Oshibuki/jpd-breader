'use strict';

function html(strings, ...substitutions) {
    var template = document.createElement('template');
    template.innerHTML = String.raw(strings, ...substitutions).trim();
    return template.content.firstElementChild;
}

function textFragments(nodes, offset = 0) {
    // Get a list of fragments (text nodes along with metainfo) contained in the given nodes
    let fragments = [];

    for (const node of nodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            // Handle text nodes directly
            const text = node.textContent;
            const length = text.length;
            fragments.push({ node, text, length, offset, furi: null });
            offset += length;
        }
        else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.hasAttribute('data-ttu-spoiler-img')) {
                // Skip this node, we don't want to parse the spoiler label as text
                continue;
            }

            // Treat <ruby> elements like text nodes, just with non-null furigana
            if (node.tagName === 'RUBY') {
                const bases = [], rubies = [];

                for (const rubyChild of node.childNodes) {
                    if (rubyChild.nodeType === Node.TEXT_NODE) {
                        bases.push(rubyChild.textContent);
                    }
                    else if (rubyChild.nodeType === Node.ELEMENT_NODE) {
                        if (rubyChild.tagName === 'RB') {
                            bases.push(rubyChild.textContent);
                        }
                        else if (rubyChild.tagName === 'RT') {
                            rubies.push(rubyChild.textContent);
                        }
                    }
                }
                const text = bases.join('');
                const length = text.length;
                const furi = bases.map((base, i) => [base, rubies[i]]);

                fragments.push({ node, text, length, offset, furi });
                offset += length;
            }

            else {
                // Recurse into the child element
                fragments.push(...textFragments(node.childNodes, offset));
            }
        }
    }

    return fragments;
}

function getPopup() {
    let popup = document.querySelector('#jpdb-popup');

    if (popup === null) {
        popup = html`<div id=jpdb-popup style="display:none;top:0;left:0;"></div>`;
        document.body.appendChild(popup);
    }

    return popup;
}

function showPopup({ target: word }) {
    if (word.vocabData === undefined)
        return;

    let popup = getPopup();

    popup.style.display = 'block';

    const box = word.getBoundingClientRect();

    // TODO choose position more cleverly
    // const {writingMode} = getComputedStyle(word);
    // const rightSpace = window.clientWidth - box.left - box.width,
    //     bottomSpace = window.clientHeight - box.top - box.height;

    // if (writingMode.startsWith('horizontal')) {
    //     if (box.top < bottomSpace)
    //         ...
    // } else {
    //     if (box.left < rightSpace)
    //         ...
    // }

    popup.style.left = `${box.right}px`;
    popup.style.top = `${box.bottom}px`;

    // popup.innerHTML = [...Object.entries(word.vocabData)].map(([key, value]) => `<b>${key}</b>: ${value}`).join('<br>');
    const v = word.vocabData;
    popup.innerHTML = `<h1><span class=spelling>${v.spelling}</span>${(v.spelling !== v.reading) ? `<span class=reading>(${v.reading})</span>` : ''}<div class=state>${v.cardState.map(s => `<span class=${s}>${s}</span>`).join('')}</div></span></h1><small>id: ${v.vid ?? '???'} / ${v.sid ?? '???'} / ${v.rid ?? '???'}</small><ol>${v.meanings.map(gloss => `<li>${gloss}</li>`).join('')}</ol>`
}

function hidePopup() {
    getPopup().style.display = 'none';
}

function furiganaToRuby(parts) {
    return parts.map(x => (typeof x === 'string') ? x : `<ruby><rb>${x[0]}</rb><rt>${x[1]}</rt></ruby>`).join('');
}

function replaceNode(original, replacement, keey_original = false) {
    console.log('Replacing:', original, 'with', replacement);

    if (!keey_original) {
        original.parentNode.replaceChild(replacement, original);
    }
    else {
        replacement.style.position = 'relative';
        original.parentNode.replaceChild(replacement, original);

        const wrapper = html`<span class="jpdb-ttu-wrapper" style="position:absolute;top:0;right:0;visibility:hidden"></span>`;
        wrapper.appendChild(original);

        replacement.appendChild(wrapper);
    }
}

function applyParseResult(fragments, result, keep_text_nodes = false) {
    // keep_text_nodes is a workaround for a ttu issue.
    //   Ttu returns to your bookmarked position at load time. 
    //   To do that, it scrolls to a specific text node.
    //   If we delete those nodes, it will crash on load when a bookmark exists.
    //   Instead, we keep the existing elements by making them invisible,
    //   and positioning them at the top right corner of our new element.
    // TODO position at top left for horizontal writing
    console.log('Applying results:', fragments, result);
    const { tokens, vocab } = result;
    let tokenIndex = 0;
    let fragmentIndex = 0;
    let curOffset = 0;
    let replacement;

    while (true) {
        if (tokenIndex >= tokens.length || fragmentIndex >= fragments.length) {
            break;
        }

        if (replacement === undefined)
            replacement = html`<span class="jpdb-parsed"></span>`;

        const fragment = fragments[fragmentIndex];
        const token = tokens[tokenIndex];
        const word = vocab[token.vocabularyIndex];

        // console.log('Fragment', fragment.text, `at ${fragment.offset}:${fragment.offset + fragment.length}`, fragment);
        const spelling = token.furigana.map(p => (typeof p === 'string') ? p : p[0]).join('');
        const reading = token.furigana.map(p => (typeof p === 'string') ? p : p[1]).join('');
        // console.log('Token', `${reading}（${spelling}）`, `at ${token.positionUtf16}:${token.positionUtf16 + token.lengthUtf16}`, token);

        if (curOffset >= fragment.offset + fragment.length) {
            replaceNode(fragment.node, replacement, keep_text_nodes);
            replacement = undefined;
            fragmentIndex++;
            // console.log('Got to end of fragment, next fragment');
            continue;
        }

        if (curOffset >= token.positionUtf16 + token.lengthUtf16) {
            tokenIndex++;
            // console.log('Got to end of token, next token');
            continue;
        }

        // curOffset is now guaranteed to be inside a fragment, and either before or inside of a token
        if (curOffset < token.positionUtf16) {
            // There are no tokens at the current offset - emit the start of the fragment unparsed
            const headString = fragment.text.slice(curOffset - fragment.offset, token.positionUtf16 - fragment.offset);
            // FIXME(Security) Not escaped
            replacement.appendChild(html`<span class="jpdb-word unparsed">${headString}</span>`);
            curOffset += headString.length;
            // console.log('Emitted unparsed string', headString);
            continue;
        }

        {
            // There is a guaranteed token at the current offset
            // TODO maybe add sanity checks here to make sure the parse is plausible?
            // TODO take into account fragment furigana
            // TODO Token might overlap end of fragment... Figure out this edge case later

            // FIXME(Security) Not escaped
            const elem = html`<span class="jpdb-word ${word.cardState.join(' ')}">${furiganaToRuby(token.furigana)}</span>`;
            elem.vocabData = word;
            elem.addEventListener('mouseenter', showPopup);
            elem.addEventListener('mouseleave', hidePopup);
            replacement.appendChild(elem);
            curOffset += token.lengthUtf16;
            tokenIndex++;
            // console.log('Emitted token');
            continue;
        }
    }

    // There might be trailing text not part of any tokens - emit it unparsed
    if (fragmentIndex < fragments.length) {
        let fragment = fragments[fragmentIndex];
        if (curOffset < fragment.offset + fragment.length) {
            const tailString = fragment.text.slice(curOffset - fragment.offset);

            // FIXME(Security) Not escaped
            replacement.appendChild(html`<span class="jpdb-word unparsed">${tailString}</span>`);
            // console.log('Emitted unparsed tail', tailString);
            replaceNode(fragment.node, replacement, keep_text_nodes);
        }
    }

}

function wrap(obj, func) {
    return new Promise((resolve, reject) => { func(obj, resolve, reject) });
}
