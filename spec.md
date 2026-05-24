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
