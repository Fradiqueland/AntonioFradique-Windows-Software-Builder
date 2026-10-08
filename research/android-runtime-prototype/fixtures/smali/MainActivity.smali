.class public Lnet/antoniofradique/builder/prototype/MainActivity;
.super Landroid/app/Activity;

.method public constructor <init>()V
    .registers 1
    invoke-direct {p0}, Landroid/app/Activity;-><init>()V
    return-void
.end method

.method public onCreate(Landroid/os/Bundle;)V
    .registers 5
    invoke-super {p0, p1}, Landroid/app/Activity;->onCreate(Landroid/os/Bundle;)V
    new-instance v0, Landroid/widget/Button;
    invoke-direct {v0, p0}, Landroid/widget/Button;-><init>(Landroid/content/Context;)V
    const-string v1, "APK RUNNING — TAP HERE\nClicks: 0"
    invoke-virtual {v0, v1}, Landroid/widget/Button;->setText(Ljava/lang/CharSequence;)V
    const/high16 v1, 0x42000000
    invoke-virtual {v0, v1}, Landroid/widget/Button;->setTextSize(F)V
    new-instance v1, Lnet/antoniofradique/builder/prototype/TapListener;
    invoke-direct {v1, v0}, Lnet/antoniofradique/builder/prototype/TapListener;-><init>(Landroid/widget/Button;)V
    invoke-virtual {v0, v1}, Landroid/widget/Button;->setOnClickListener(Landroid/view/View$OnClickListener;)V
    invoke-virtual {p0, v0}, Landroid/app/Activity;->setContentView(Landroid/view/View;)V
    return-void
.end method
