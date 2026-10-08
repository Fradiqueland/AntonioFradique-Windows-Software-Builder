.class public Lnet/antoniofradique/builder/prototype/TapListener;
.super Ljava/lang/Object;
.implements Landroid/view/View$OnClickListener;
.field private button:Landroid/widget/Button;
.field private clicks:I

.method public constructor <init>(Landroid/widget/Button;)V
    .registers 2
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
    iput-object p1, p0, Lnet/antoniofradique/builder/prototype/TapListener;->button:Landroid/widget/Button;
    return-void
.end method

.method public onClick(Landroid/view/View;)V
    .registers 5
    iget v0, p0, Lnet/antoniofradique/builder/prototype/TapListener;->clicks:I
    add-int/lit8 v0, v0, 0x1
    iput v0, p0, Lnet/antoniofradique/builder/prototype/TapListener;->clicks:I
    new-instance v1, Ljava/lang/StringBuilder;
    invoke-direct {v1}, Ljava/lang/StringBuilder;-><init>()V
    const-string v2, "APK RUNNING — TAP HERE\nClicks: "
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v1, v0}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    invoke-virtual {v1}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v1
    iget-object v0, p0, Lnet/antoniofradique/builder/prototype/TapListener;->button:Landroid/widget/Button;
    invoke-virtual {v0, v1}, Landroid/widget/Button;->setText(Ljava/lang/CharSequence;)V
    return-void
.end method
