I want to build an mobile app, starting from ios (if possible supporting andriod too), that displays sutra and tracks
how much I've read.
the source of sutra could be found from sites like https://mingguang.im/library/longz/index.html or https://cbetaonline.dila.edu.tw/zh/ or any other sources y ou can find online.
The source could be either online or offline, but I would like to continue read even I don't have network for a while.
The most important feature of this app, different from others is, it shows a progress at the homepage, and I can continue reading
from anywhere I left with, or I can start reading from any where. When I start, I click a button "start" and when I'm done I click another button "save progress", or "bookmark", or "mark I'm here".
I should be able to start from anywhere of any sutra, not just from the beginning.
The progress should shows as little dots, and graudally fill the whole progress. It could be a square, or a 卍 figure, or some other figure that will be filled gradually. So that I can my progress: how much have I read? Clicking any of the dots should bring me to a
place inside the sutra sea, and I can start reading from here. Also hover on a dot should show the name like: 
大般若波罗蜜多经·卷第五百一十三 第三分真如品第十九之一. A dot can be partially filled.
Also there is a outline view (other than the dots) can show the whole sura sea linearly, based on an order listed in the source.
Progresses should be saved in icloud (or any persistent cloud the user has easy access to, e.g. google drive, etc.) so that if I switch a device I can see the same progress and continue from there.
Note that there are multiple bookmarks: I may start reading 大般若波罗蜜多经, finish a part of it, then switch to a different sutra.
The display should be good for reading, not too crowded, not too small. clear and comfortable.
I could be stopping at the middle of any page, so bookmarks need to be able to record arbitrary positions in the sea.
I prefer reading simplifiled Chinese.
Note that the progress dots should show the global progress, that is, it shows how much I have finished in the whole sea. So you may add more dots to the homepage, and partially hightlight a dot if it is partially finished. I need a global perspective so that I know how much I finished.
I should be able to search a sutra, open it, and start reading.
Active bookmarks should represent only readings that are still in progress. When I finish a whole book, its active bookmark should disappear, but its completed progress should remain saved and should continue to fill the corresponding global progress dot.
The app should keep progress and bookmarks as separate concepts: progress records what has been read, while active bookmarks are only resumable unfinished reading positions.
Active bookmarks should not show a persistent delete button; deleting should use a left-swipe interaction that reveals a delete confirmation button, similar to deleting a message in iMessage.
Opening a bookmark in a long sutra should jump directly to the saved position without visibly scrolling from the beginning of the text.
Opening a bookmark should show the marked text block in view, preferably slightly below the top edge, and use a subtle background highlight without an outline border.
The active bookmark list should be scrollable when there are many unfinished readings, and its left-swipe delete gesture should be easy to trigger without interfering with vertical scrolling.
The reader should use a single “记到此处” action for saving progress; separate start/bookmark buttons are not needed.
The “记到此处” action should live in the reader's top-right header area so the bottom of the screen can show more sutra text.
There should be at most one active bookmark per sutra. Pressing “记到此处” should update that sutra's active bookmark instead of creating duplicates.
If a bookmark row's delete button is revealed, swiping right or tapping the row should hide the delete button.
The left-swipe delete gesture should stay open after a short left drag instead of snapping closed; a right swipe should close it.
The left-swipe delete gesture should also open reliably after a quick left flick; it should not briefly reveal the delete button and then snap closed unless the user intentionally swipes right.
When the reader reaches the end of a sutra, it should show a “下一部” button that opens the next work in library order when one exists. The sticky “记到此处” button should remain the only progress-marking action, so it should not be duplicated in the end-of-text panel.
Tapping “下一部” at the end of a sutra should first record the current sutra as read through its end, apply the usual completed-book bookmark cleanup, and then open the next work.
Bookmarks should be removed only when their own work is completed. Saving a new position in an unfinished work should replace that work's active bookmark, not remove it.
If a bookmark position is at the end of a work, or if tapping “下一部” records the current work through its end, that work should be marked DONE and its unfinished active bookmark should be replaced by a temporary completed-end anchor.
The temporary completed-end anchor should remain until the user saves a new bookmark elsewhere, so returning home does not lose the latest reading boundary.
Clicking a global progress dot should open the exact temporary completed-end anchor when that anchor is inside the dot's range; otherwise it should open the first unread work/position inside that dot's range, skipping works and pages already marked read.
Library search results should show each work's local progress, using an explicit completed state/color when the work is done and a percentage when it is partially read.
The reader page should show the current work's local progress near the header, alongside the back and “记到此处” controls.
Very long works should scroll smoothly without blank virtualized gaps or jumpy correction; the reader should avoid fragile estimated-height virtualization and may render long source paragraphs as smaller continuous reading chunks while preserving bookmark positions within the original work.
Opening a bookmark should retry exact scroll restoration until the saved text chunk has been measured, so long works do not remain at the beginning because of a layout race.
Opening a work should show a visible loading indicator while the text is being loaded and prepared, including cached works whose local JSON parsing/layout preparation may still take noticeable time.
The app should support manual progress transfer without cloud sync: export reading progress/bookmarks as a JSON backup file through the system share sheet, and import that file on another device by merging read ranges and keeping the newest bookmark per work.
CBETA source line breaks should not be rendered as separate reading paragraphs with large vertical gaps or as visible spaces between Chinese characters; the reader should merge line-level text into comfortable continuous paragraphs.
Cached sutra text should be normalized on load so older cached works with spaces from source line breaks are repaired automatically.
