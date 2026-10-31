using System;
using System.IO;
using System.Windows.Forms;

namespace QuanLyKho;

static class Program
{
    [STAThread]
    static void Main()
    {
        try
        {
            ApplicationConfiguration.Initialize();
            Application.Run(new Form1());
        }
        catch (Exception ex)
        {
            File.WriteAllText("crash.log", ex.ToString());
            MessageBox.Show("Crash: " + ex.ToString(), "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }    
}
